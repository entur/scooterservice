/**
 * Temporary endpoint to convert GBFS v1 feeds to v2.1
 *
 * This endpoint exists solely to have real data to develop
 * mobility v2 api against, and should not be used by external
 * parties.
 *
 * The duplication of code in this file is therefore intentional,
 * to avoid coupling with the rest of the codebase as much as possible
 *
 */
import * as functions from 'firebase-functions'
import * as request from 'superagent'
import * as express from 'express'
import { logError } from './utils/logging'
import { Operator } from './utils/operators'
import {
    boltOsloScooterPrice,
    boltFredrikstadScooterPrice,
    boltLillestromScooterPrice,
    defaultScooterPrice,
    limeScooterPrice,
} from './utils/constants'
import { ScooterPrice } from './utils/interfaces'

enum Provider {
    voioslo = 'voioslo',
    voitrondheim = 'voitrondheim',
    limeoslo = 'limeoslo',
    boltoslo = 'boltoslo',
    boltlillestrom = 'boltlillestrom',
    boltfredrikstad = 'boltfredrikstad',
}

enum Feed {
    gbfs = 'gbfs',
    gbfs_versions = 'gbfs_versions',
    system_information = 'system_information',
    vehicle_types = 'vehicle_types',
    station_information = 'station_information',
    station_status = 'station_status',
    free_bike_status = 'free_bike_status',
    system_hours = 'system_hours',
    system_calendar = 'system_calendar',
    system_regions = 'system_regions',
    system_pricing_plans = 'system_pricing_plans',
    system_alerts = 'system_alerts',
    geofencing_zones = 'geofencing_zones',
}

const app = express()

const lastUpdated = new Date().getTime()

app.get(
    '/:provider/:feed',
    async (req, res): Promise<void> => {
        const { provider: providerString, feed: feedString } = req.params

        if (!isProviderName(providerString) || !isFeedName(feedString)) {
            res.sendStatus(404)
        }

        const provider = <keyof typeof Provider>providerString
        const feed = <keyof typeof Feed>feedString

        if (feed == Feed.gbfs) {
            res.status(200).send(getDiscoveryFeed(provider))
        } else if (
            feed === Feed.vehicle_types &&
            provider !== Provider.limeoslo
        ) {
            res.status(200).send(getVehicleTypesFeed(provider))
        } else if (feed === Feed.system_pricing_plans) {
            res.status(200).send(getSystemPricingPlansFeed(provider))
        } else {
            const feedUrl = getFeedUrl(provider, feed)
            const bearerToken = await getBearerToken(provider)
            const feedResponse = await getFeed(provider, feedUrl, bearerToken)
            const mappedFeed = mapFeed(provider, feed, feedResponse)
            res.status(200).send(mappedFeed)
        }
    },
)

function mapFeed<T extends keyof typeof Provider, S extends keyof typeof Feed>(
    provider: T,
    feed: S,
    feedResponse: string,
): GBFSBase {
    switch (feed) {
        case Feed.gbfs:
            return getDiscoveryFeed(provider)
        case Feed.system_information:
            return mapSystemInformationFeed(provider, feedResponse)
        case Feed.vehicle_types:
            return mapVehicleTypesFeed(provider, feedResponse)
        case Feed.free_bike_status:
            return mapFreeBikeStatusFeed(provider, feedResponse)
        default:
            throw new Error('Unknown feed')
    }
}

function getDiscoveryFeed<T extends keyof typeof Provider>(provider: T): GBFS {
    return {
        last_updated: lastUpdated,
        ttl: 300,
        version: '2.1',
        data: {
            en: {
                feeds: [
                    {
                        name: 'system_information',
                        url: `https://api.staging.entur.io/mobility/v1/gbfs-v2_1/${provider}/system_information`,
                    },
                    {
                        name: 'vehicle_types',
                        url: `https://api.staging.entur.io/mobility/v1/gbfs-v2_1/${provider}/vehicle_types`,
                    },
                    {
                        name: 'free_bike_status',
                        url: `https://api.staging.entur.io/mobility/v1/gbfs-v2_1/${provider}/free_bike_status`,
                    },
                    {
                        name: 'system_pricing_plans',
                        url: `https://api.staging.entur.io/mobility/v1/gbfs-v2_1/${provider}/system_pricing_plans`,
                    },
                ],
            },
        },
    }
}

function mapSystemInformationFeed<T extends keyof typeof Provider>(
    provider: T,
    feedResponse: string,
): SystemInformation {
    const {
        last_updated,
        data: { system_id, language, name, url, timezone },
    }: SystemInformation = JSON.parse(feedResponse)

    const codespace = getCodespace(provider)

    return {
        last_updated,
        ttl: 300,
        version: '2.1',
        data: {
            system_id: `${codespace}:System:${system_id}Oslo`,
            language,
            name,
            url,
            timezone,
        },
    }
}

function getVehicleTypesFeed<T extends keyof typeof Provider>(
    provider: T,
): VehicleTypes {
    const codespace = getCodespace(provider)

    return {
        last_updated: lastUpdated,
        ttl: 300,
        version: '2.1',
        data: {
            vehicle_types: [
                {
                    vehicle_type_id: `${codespace}:VehicleType:Scooter`,
                    form_factor: 'scooter',
                    propulsion_type: 'electric',
                    max_range_meters: 0,
                },
            ],
        },
    }
}

function mapVehicleTypesFeed<T extends keyof typeof Provider>(
    provider: T,
    feedResponse: string,
): VehicleTypes {
    const vehicleTypes: VehicleTypes = JSON.parse(feedResponse)
    const codespace = getCodespace(provider)
    return {
        last_updated: vehicleTypes.last_updated,
        ttl: 300,
        version: '2.1',
        data: {
            vehicle_types: vehicleTypes.data.vehicle_types.map(
                (vehicleType) => {
                    return {
                        vehicle_type_id: `${codespace}:VehicleType:${vehicleType.vehicle_type_id}`,
                        form_factor: vehicleType.form_factor,
                        propulsion_type: vehicleType.propulsion_type,
                        max_range_meters: vehicleType.max_range_meters || 0,
                    }
                },
            ),
        },
    }
}

function mapFreeBikeStatusFeed<T extends keyof typeof Provider>(
    provider: T,
    feedResponse: string,
): FreeBikeStatus {
    const freeBikeStatus: FreeBikeStatus = JSON.parse(feedResponse)
    const codespace = getCodespace(provider)

    return {
        last_updated: freeBikeStatus.last_updated,
        ttl: 300,
        version: '2.1',
        data: {
            bikes: freeBikeStatus.data.bikes.map((bike: any) => ({
                bike_id: `${codespace}:Scooter:${bike.bike_id}`,
                lat: bike.lat,
                lon: bike.lon,
                is_reserved: bike.is_reserved === 1,
                is_disabled: bike.is_disabled === 1,
                vehicle_type_id: `${codespace}:VehicleType:${
                    bike.vehicle_type_id || 'Scooter'
                }`,
                current_range_meters: bike.current_range_meters || 0,
                pricing_plan_id: `${codespace}:PricingPlan:${
                    bike.pricing_plan_id || 'Basic'
                }`,
                last_reported: bike.last_reported || null,
                station_id: null,
                rental_uris: bike.rental_uris ? bike.rental_uris : null,
            })),
        },
    }
}

function getSystemPricingPlansFeed<T extends keyof typeof Provider>(
    provider: T,
): SystemPricingPlans {
    const codespace = getCodespace(provider)
    const price: ScooterPrice = getSystemPricing(provider)

    return {
        last_updated: lastUpdated,
        ttl: 300,
        version: '2.1',
        data: {
            plans: [
                {
                    plan_id: `${codespace}:PricingPlan:Basic`,
                    name: 'Basic',
                    currency: 'NOK',
                    price: price.startPrice,
                    is_taxable: false,
                    description: `Start NOK ${price.startPrice}, Per minute ${price.pricePerMinute} NOK`,
                    per_min_pricing: [
                        {
                            start: 0,
                            rate: price.pricePerMinute,
                            interval: 1,
                        },
                    ],
                },
            ],
        },
    }
}

function getSystemPricing<T extends keyof typeof Provider>(
    provider: T,
): ScooterPrice {
    switch (provider) {
        case Provider.boltoslo:
            return boltOsloScooterPrice
        case Provider.boltfredrikstad:
            return boltFredrikstadScooterPrice
        case Provider.boltlillestrom:
            return boltLillestromScooterPrice
        case Provider.limeoslo:
            return limeScooterPrice
        default:
            return defaultScooterPrice
    }
}

function getCodespace<T extends keyof typeof Provider>(provider: T): string {
    switch (provider) {
        case Provider.voioslo:
        case Provider.voitrondheim:
            return 'YVO'
        case Provider.limeoslo:
            return 'YLI'
        case Provider.boltoslo:
        case Provider.boltfredrikstad:
        case Provider.boltlillestrom:
            return 'YBO'
        default:
            throw new Error('Unknown provider')
    }
}

function isProviderName(name: string): name is Provider {
    return name in Provider
}

function isFeedName(name: string): name is Feed {
    return name in Feed
}

function getFeedUrl<
    T extends keyof typeof Provider,
    S extends keyof typeof Feed
>(provider: T, feed: S): string {
    switch (provider) {
        case Provider.voioslo:
            return functions
                .config()
                .voi.url.oslo.replace('free_bike_status', feed)
        case Provider.voitrondheim:
            return functions
                .config()
                .voi.url.trondheim.replace('free_bike_status', feed)
        case Provider.limeoslo:
            return functions
                .config()
                .lime.url.oslo.replace('free_bike_status', feed)
        case Provider.boltoslo:
            return functions
                .config()
                .bolt.url.oslo.replace('free_bike_status', feed)
        case Provider.boltfredrikstad:
            return functions
                .config()
                .bolt.url.fredrikstad.replace('free_bike_status', feed)
        case Provider.boltlillestrom:
            return functions
                .config()
                .bolt.url.lillestrom.replace('free_bike_status', feed)
        default:
            throw new Error('Unknown provider')
    }
}

async function getBearerToken<T extends keyof typeof Provider>(
    provider: T,
): Promise<string> {
    switch (provider) {
        case Provider.voioslo:
        case Provider.voitrondheim:
            return await getVoiBearerToken()
        case Provider.limeoslo:
            return await getLimeOsloToken()
        case Provider.boltoslo:
            return await getBoltOsloToken()
        case Provider.boltfredrikstad:
            return await getBoltFredrikstadToken()
        case Provider.boltlillestrom:
            return await getBoltLillestromToken()
        default:
            throw new Error('Unknown provider')
    }
}

async function getFeed<T extends keyof typeof Provider>(
    provider: T,
    feedUrl: string,
    bearerToken: string,
): Promise<string> {
    switch (provider) {
        case Provider.voioslo:
        case Provider.voitrondheim:
            return await getVoiFeed(feedUrl, bearerToken)
        case Provider.limeoslo:
            return await getLimeFeed(feedUrl, bearerToken)
        case Provider.boltoslo:
        case Provider.boltfredrikstad:
        case Provider.boltlillestrom:
            return await getBoltFeed(feedUrl, bearerToken)
        default:
            throw new Error('Unknown provider')
    }
}

async function getVoiFeed(
    feedUrl: string,
    bearerToken: string,
): Promise<string> {
    const response: request.Response = await request
        .get(feedUrl)
        .set('Authorization', `Bearer ${bearerToken}`)
        .set('Accept', 'application/vnd.mds.provider+json;version=0.3')
    return response.text
}

async function getLimeFeed(
    feedUrl: string,
    bearerToken: string,
): Promise<string> {
    const response: request.Response = await request
        .get(feedUrl)
        .set('Authorization', `Bearer ${bearerToken}`)
    return response.text
}

async function getBoltFeed(
    feedUrl: string,
    bearerToken: string,
): Promise<string> {
    const response: request.Response = await request
        .get(feedUrl)
        .set('Authorization', `Bearer ${bearerToken}`)
        .set('Accept', 'application/json')
    return response.text
}

async function getVoiBearerToken(): Promise<string> {
    try {
        const res: request.Response = await request
            .post(`${functions.config().voi.url.sessionkey}`)
            .auth(
                functions.config().voi.api.user,
                functions.config().voi.api.pass,
            )
            .set('Accept', 'application/vnd.mds.provider+json;version=0.3')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send('grant_type=client_credentials')
        return JSON.parse(res.text).access_token
    } catch (err) {
        logError(Operator.VOI, err, 'Failed to refresh session key')
        return Promise.reject()
    }
}

async function getLimeOsloToken(): Promise<string> {
    return functions.config().lime.api.token
}

async function getBoltOsloToken(): Promise<string> {
    return await getBoltToken(
        functions.config().bolt.api.oslo.user,
        functions.config().bolt.api.oslo.pass,
    )
}

async function getBoltFredrikstadToken(): Promise<string> {
    return await getBoltToken(
        functions.config().bolt.api.fredrikstad.user,
        functions.config().bolt.api.fredrikstad.pass,
    )
}

async function getBoltLillestromToken(): Promise<string> {
    return await getBoltToken(
        functions.config().bolt.api.lillestrom.user,
        functions.config().bolt.api.lillestrom.pass,
    )
}

async function getBoltToken(user: string, pass: string): Promise<string> {
    console.log(
        `Refreshing ${Operator.BOLT.toLowerCase()} token with user ${user}`,
    )
    try {
        const res: request.Response = await request
            .post(`${functions.config().bolt.url.auth}`)
            .set('Content-Type', 'application/json')
            .send({
                user_name: user,
                user_pass: pass,
            })
        return JSON.parse(res.text).access_token
    } catch (err) {
        logError(Operator.BOLT, err, 'Failed to refresh session key')
        return Promise.reject()
    }
}

export const v2_1 = functions.region('europe-west1').https.onRequest(app)