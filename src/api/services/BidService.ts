// Copyright (c) 2017-2019, The Particl Market developers
// Distributed under the GPL software license, see the accompanying
// file COPYING or https://github.com/particl/particl-market/blob/develop/LICENSE

import * as resources from 'resources';
import * as Bookshelf from 'bookshelf';
import * as _ from 'lodash';
import { inject, named } from 'inversify';
import { Logger as LoggerType } from '../../core/Logger';
import { Types, Core, Targets } from '../../constants';
import { validate, request } from '../../core/api/Validate';
import { NotFoundException } from '../exceptions/NotFoundException';
import { ValidationException } from '../exceptions/ValidationException';
import { BidRepository } from '../repositories/BidRepository';
import { Bid } from '../models/Bid';
import { BidCreateRequest } from '../requests/BidCreateRequest';
import { BidUpdateRequest } from '../requests/BidUpdateRequest';
import { BidDataCreateRequest } from '../requests/BidDataCreateRequest';
import { BidSearchParams } from '../requests/BidSearchParams';
import { EventEmitter } from 'events';
import { BidDataService } from './BidDataService';
import { ListingItemService } from './ListingItemService';
import { AddressService } from './AddressService';
import { ProfileService } from './ProfileService';
import { SearchOrder } from '../enums/SearchOrder';
import { OrderCreateRequest } from '../requests/OrderCreateRequest';
import { MPAction } from 'omp-lib/dist/interfaces/omp-enums';
import { AddressCreateRequest } from '../requests/AddressCreateRequest';
import { OrderItemCreateRequest } from '../requests/OrderItemCreateRequest';
import { ObjectHash } from '../../core/helpers/ObjectHash';
import { HashableObjectType } from '../enums/HashableObjectType';
import { MessageException } from '../exceptions/MessageException';
import { AddressType } from '../enums/AddressType';
import { OrderItemStatus } from '../enums/OrderItemStatus';
import { OrderItemObjectCreateRequest } from '../requests/OrderItemObjectCreateRequest';

export class BidService {

    public log: LoggerType;

    constructor(
        @inject(Types.Repository) @named(Targets.Repository.BidRepository) public bidRepo: BidRepository,
        @inject(Types.Service) @named(Targets.Service.BidDataService) public bidDataService: BidDataService,
        @inject(Types.Service) @named(Targets.Service.ListingItemService) public listingItemService: ListingItemService,
        @inject(Types.Service) @named(Targets.Service.AddressService) public addressService: AddressService,
        @inject(Types.Service) @named(Targets.Service.ProfileService) public profileService: ProfileService,
        @inject(Types.Core) @named(Core.Events) public eventEmitter: EventEmitter,
        @inject(Types.Core) @named(Core.Logger) public Logger: typeof LoggerType
    ) {
        this.log = new Logger(__filename);
    }

    public async findAll(): Promise<Bookshelf.Collection<Bid>> {
        return await this.bidRepo.findAll();
    }

    public async findOne(id: number, withRelated: boolean = true): Promise<Bid> {
        const bid = await this.bidRepo.findOne(id, withRelated);
        if (bid === null) {
            this.log.warn(`Bid with the id=${id} was not found!`);
            throw new NotFoundException(id);
        }
        return bid;
    }

    public async findOneByHash(hash: string, withRelated: boolean = true): Promise<Bid> {
        const bid = await this.bidRepo.findOneByHash(hash, withRelated);
        if (bid === null) {
            this.log.warn(`Bid with the hash=${hash} was not found!`);
            throw new NotFoundException(hash);
        }
        return bid;
    }

    public async findAllByListingItemHash(hash: string, withRelated: boolean = true): Promise<Bookshelf.Collection<Bid>> {
        const params = {
            listingItemHash: hash
        } as BidSearchParams;
        return await this.search(params);
    }

    /**
     * searchBy Bid using given BidSearchParams
     *
     * @param options
     * @param withRelated
     * @returns {Promise<Bookshelf.Collection<Bid>>}
     */
    @validate()
    public async search(@request(BidSearchParams) options: BidSearchParams, withRelated: boolean = true): Promise<Bookshelf.Collection<Bid>> {

        // if item hash was given, set the item id
        if (options.listingItemHash) {
            const foundListing = await this.listingItemService.findOneByHash(options.listingItemHash, false);
            options.listingItemId = foundListing.Id;
        }
        return await this.bidRepo.search(options, withRelated);
    }

    @validate()
    public async getLatestBid(listingItemId: number, bidder: string): Promise<Bid> {
        // return await this.bidRepo.getLatestBid(listingItemId, bidder);
        return await this.search({
            listingItemId,
            bidders: [ bidder ],
            ordering: SearchOrder.DESC
        } as BidSearchParams, true)[0];
    }

    @validate()
    public async create(@request(BidCreateRequest) data: BidCreateRequest): Promise<Bid> {

        // TODO: hash generation

        const body = JSON.parse(JSON.stringify(data));
        // this.log.debug('BidCreateRequest:', JSON.stringify(body, null, 2));

        // bid needs is related to listing item
        if (body.listing_item_id == null) {
            this.log.error('Request body is not valid, listing_item_id missing');
            throw new ValidationException('Request body is not valid', ['listing_item_id missing']);
        }

        // bid needs to have a bidder
        if (body.bidder == null) {
            this.log.error('Request body is not valid, bidder missing');
            throw new ValidationException('Request body is not valid', ['bidder missing']);
        }

        // shipping address
        if (body.address == null) {
            this.log.error('Request body is not valid, address missing');
            throw new ValidationException('Request body is not valid', ['address missing']);
        }

        const addressCreateRequest = body.address;
        delete body.address;

        // in case there's no profile id, figure it out
        if (!addressCreateRequest.profile_id) {
            const foundBidderProfile = await this.profileService.findOneByAddress(body.bidder);
            if (foundBidderProfile) {
                // we are the bidder
                addressCreateRequest.profile_id = foundBidderProfile.id;
            } else {
                try {
                    // we are the seller
                    const listingItemModel = await this.listingItemService.findOne(body.listing_item_id);
                    const listingItem = listingItemModel.toJSON();
                    addressCreateRequest.profile_id = listingItem.ListingItemTemplate.Profile.id;
                } catch (e) {
                    this.log.error('Funny test data bid? It seems we are neither bidder nor the seller.');
                }
            }
        }

        // this.log.debug('address create request: ', JSON.stringify(addressCreateRequest, null, 2));
        const addressModel = await this.addressService.create(addressCreateRequest);
        const address = addressModel.toJSON();
        // this.log.debug('created address: ', JSON.stringify(address, null, 2));

        // set the address_id for bid
        body.address_id = address.id;

        const bidDatas = body.bidDatas || [];
        delete body.bidDatas;

        // this.log.debug('body: ', JSON.stringify(body, null, 2));
        // If the request body was valid we will create the bid
        const bid = await this.bidRepo.create(body);

        for (const dataToSave of bidDatas) {
            // todo: move to biddataservice?
            dataToSave.bid_id = bid.Id;
            // todo: test with different types of dataValue
            dataToSave.dataValue = typeof (dataToSave.dataValue) === 'string' ? dataToSave.dataValue : JSON.stringify(dataToSave.dataValue);

            // this.log.debug('dataToSave: ', JSON.stringify(dataToSave, null, 2));
            await this.bidDataService.create(dataToSave);
        }

        // finally find and return the created bid
        const newBid = await this.findOne(bid.Id);
        return newBid;
    }

    @validate()
    public async update(id: number, @request(BidUpdateRequest) data: BidUpdateRequest): Promise<Bid> {

        const body = JSON.parse(JSON.stringify(data));

        // find the existing one without related
        const bid = await this.findOne(id, false);

        // extract and remove related models from request
        const bidDatas: BidDataCreateRequest[] = body.bidDatas || [];
        delete body.bidDatas;

        // set new values, we only need to change the type
        bid.Type = body.type;
        bid.Hash = body.hash;

        // update bid record
        const updatedBid = await this.bidRepo.update(id, bid.toJSON());

        // remove old BidDatas
        if (bidDatas) {
            const oldBidDatas = updatedBid.related('BidDatas').toJSON();
            for (const bidData of oldBidDatas) {
                await this.bidDataService.destroy(bidData.id);
            }

            // create new BidDatas
            for (const bidData of bidDatas) {
                bidData.bid_id = id;
                bidData.value = typeof (bidData.value) === 'string' ? bidData.value : JSON.stringify(bidData.value);
                await this.bidDataService.create(bidData);
            }
        }

        return await this.findOne(id, true);
    }

    public async destroy(id: number): Promise<void> {
        await this.bidRepo.destroy(id);
    }

    // TODO: refactor and move this!!!
    /**
     * create a OrderCreateRequest
     *
     * @param {"resources".Bid} bid
     * @returns {Promise<OrderCreateRequest>}
     */
    public async getOrderFromBid(bid: resources.Bid): Promise<OrderCreateRequest> {

        // only bids with type MPA_ACCEPT can be converted to Order
        if (bid.type === MPAction.MPA_ACCEPT) {

            const address: AddressCreateRequest = this.getShippingAddress(bid);
            const orderItems: OrderItemCreateRequest[] = this.getOrderItems(bid);
            const buyer: string = bid.bidder;
            const seller: string = bid.ListingItem.seller;

            const orderCreateRequest = {
                address,
                orderItems,
                buyer,
                seller
            } as OrderCreateRequest;

            // can we move this hashing to service level
            orderCreateRequest.hash = ObjectHash.getHash(orderCreateRequest, HashableObjectType.ORDER_CREATEREQUEST);
            return orderCreateRequest;

        } else {
            throw new MessageException('Cannot create Order from this MPAction.');
        }
    }

    private getShippingAddress(bid: resources.Bid): AddressCreateRequest {
        return {
            profile_id: bid.ShippingAddress.Profile.id,
            firstName: bid.ShippingAddress.firstName,
            lastName: bid.ShippingAddress.lastName,
            addressLine1: bid.ShippingAddress.addressLine1,
            addressLine2: bid.ShippingAddress.addressLine2,
            city: bid.ShippingAddress.city,
            state: bid.ShippingAddress.state,
            zipCode: bid.ShippingAddress.zipCode,
            country: bid.ShippingAddress.country,
            type: AddressType.SHIPPING_ORDER
        } as AddressCreateRequest;
    }

    private getOrderItems(bid: resources.Bid): OrderItemCreateRequest[] {

        const orderItemCreateRequests: OrderItemCreateRequest[] = [];
        const orderItemObjects = this.getOrderItemObjects(bid.BidDatas);

        const orderItemCreateRequest = {
            bid_id: bid.id,
            itemHash: bid.ListingItem.hash,
            status: OrderItemStatus.AWAITING_ESCROW,
            orderItemObjects
        } as OrderItemCreateRequest;

        // in alpha 1 order contains 1 orderItem
        orderItemCreateRequests.push(orderItemCreateRequest);
        return orderItemCreateRequests;
    }

    private getOrderItemObjects(bidDatas: resources.BidData[]): OrderItemObjectCreateRequest[] {
        const orderItemObjectCreateRequests: OrderItemObjectCreateRequest[] = [];
        for (const bidData of bidDatas) {
            const orderItemObjectCreateRequest = {
                key: bidData.key,
                value: bidData.value
            } as OrderItemObjectCreateRequest;
            orderItemObjectCreateRequests.push(orderItemObjectCreateRequest);
        }
        return orderItemObjectCreateRequests;
    }

}
