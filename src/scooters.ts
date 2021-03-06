import * as functions from 'firebase-functions'
import * as request from 'superagent'
import {
    CLIENT_ENTUR,
    CLIENT_HEADER_NAME,
    TIER_MAX_RANGE,
} from './utils/constants'
import { distance } from './utils/distance'
import { toggles } from './utils/firebase'
import {
    ScooterQuery,
    Vehicle,
    Voi,
    Zvipp,
    Lime,
    Bolt,
} from './utils/interfaces'
import { capitalizeFirstLetter, logError } from './utils/logging'
import { mapTier, mapVoi, mapZvipp, mapLime, mapBolt } from './utils/mappers'
import {
    Operator,
    isOperatorName,
    ALL_OPERATORS,
    BoltOperatorCity,
} from './utils/operators'
import { getCachedScooters } from './utils/cache'

let voiSessionKey = ''
let boltOsloToken = ''
let boltLillestromToken = ''
let boltFredrikstadToken = ''
let boltBergenToken = ''

const bboxNorway = {
    topLeft: {
        lon: 4.99207807783,
        lat: 80.6571442736,
    },
    bottomRight: {
        lon: 31.29341841,
        lat: 58.0788841824,
    },
}

const logClientName = (client: string): void => {
    if (!client.startsWith(CLIENT_ENTUR)) {
        console.log(`ET-Client-Name: ${client}`)
    }
}

export const scooters = functions.region('europe-west1').https.onRequest(
    async (req, res): Promise<void> => {
        if (req.method === 'OPTIONS') {
            res.status(200).send()
            return
        }

        const client = req.get(CLIENT_HEADER_NAME)
        if (!client) {
            res.status(400).send(
                "ET-Client-Name header missing. Please include a header 'ET-Client-Name' with a value on the form 'Organization - Usecase'.",
            )
            console.log(`ET-Client-Name missing!`)
            return
        }

        const query: ScooterQuery = req.query

        const lat = Number(query.lat)
        const lon = Number(query.lon)

        if (!lat || !lon) {
            res.status(400).send('Coordinates missing (lat and lon)')
            return
        }

        const range =
            Number(query.range) > TIER_MAX_RANGE
                ? TIER_MAX_RANGE
                : Number(query.range) || 200
        const max = Number(query.max || 20)

        logClientName(client)

        const { operators } = query

        const operatorsArgument = operators ? operators.split(',') : undefined

        const invalidOperators =
            operatorsArgument &&
            operatorsArgument.filter(
                (name) => !isOperatorName(name.toUpperCase()),
            )

        if (invalidOperators?.length) {
            res.status(400).send(
                `Invalid operator names passed: ${invalidOperators.join(', ')}`,
            )
            return
        }

        const operatorsWhitelist =
            operatorsArgument &&
            operatorsArgument
                .map((name) => name.toUpperCase())
                .filter(isOperatorName)

        try {
            const vehicles: Vehicle[] = await getScooters(
                lat,
                lon,
                range,
                operatorsWhitelist,
            )

            // Filter out vehicles outside rudimentary
            // bounding box for Norway
            const vehiclesInNorway = vehicles.filter(
                (p) =>
                    bboxNorway.topLeft.lon <= p.lon &&
                    p.lon <= bboxNorway.bottomRight.lon &&
                    bboxNorway.topLeft.lat >= p.lat &&
                    p.lat >= bboxNorway.bottomRight.lat,
            )

            const closestVehicles: Vehicle[] = vehiclesInNorway
                .sort(
                    (v1, v2) =>
                        distance(lat, lon, v1.lat, v1.lon) -
                        distance(lat, lon, v2.lat, v2.lon),
                )
                .slice(0, max)

            console.log(
                `Scooters nearby (${lat}, ${lon}, range: ${range}, max: ${max}): ${closestVehicles.length}`,
            )
            res.status(200).send(closestVehicles)
        } catch (e) {
            console.error('Unhandled error', e)
            res.status(500).send(e)
        }
    },
)

async function getScooters(
    lat: number,
    lon: number,
    range: number,
    operatorsWhitelist: Operator[] = ALL_OPERATORS,
): Promise<Vehicle[]> {
    const scooters = await Promise.all(
        operatorsWhitelist.map((operator) => {
            switch (operator) {
                case Operator.VOI:
                    return getCachedScooters(operator, () => getVoiScooters())
                case Operator.TIER:
                    return getTierScooters(lat, lon, range)
                case Operator.ZVIPP:
                    return getCachedScooters(operator, () => getZvippScooters())
                case Operator.LIME:
                    return getCachedScooters(operator, () => getLimeScooters())
                case Operator.BOLT:
                    return getCachedScooters(operator, () => getBoltScooters())
                default:
                    return []
            }
        }),
    )

    return scooters
        .reduce((a, b) => [...a, ...b], [])
        .filter(
            (vehicle: Vehicle) =>
                vehicle.operator === Operator.TIER ||
                distance(lat, lon, vehicle.lat, vehicle.lon) <= range,
        )
}

async function getTierScooters(lat: number, lon: number, range: number) {
    if (toggles().tier === 'off') {
        console.log(`${capitalizeFirstLetter(Operator.TIER)} is toggled off`)
        return []
    }
    const url = `${
        functions.config().tier.url.all
    }?lat=${lat}&lng=${lon}&radius=${range}`

    try {
        const tierResponse: request.Response = await request
            .get(url)
            .set('x-api-key', functions.config().tier.api.key)
        const tier = JSON.parse(tierResponse.text).data
        return mapTier(tier)
    } catch (err) {
        logError(Operator.TIER, err)
        return []
    }
}

async function getVoiScooters() {
    if (toggles().voi === 'off') {
        console.log(`${capitalizeFirstLetter(Operator.VOI)} is toggled off`)
        return []
    }

    try {
        return await voiRequest()
    } catch (err) {
        if (err && err.status === 401) {
            try {
                await refreshVoiSessionKey()
                return await voiRequest()
            } catch (e) {
                logError(Operator.VOI, err)
                return []
            }
        } else {
            logError(Operator.VOI, err)
            return []
        }
    }
}

async function voiRequest() {
    let voiOslo: Voi[] = []
    let voiTrondheim: Voi[] = []

    const voiOsloResponse: request.Response = await request
        .get(`${functions.config().voi.url.oslo}`)
        .set('Authorization', `Bearer ${voiSessionKey}`)
        .set('X-Voigbfs-Ext', 'Battery')
        .set('Accept', 'application/vnd.mds.provider+json;version=0.3')
    voiOslo = JSON.parse(voiOsloResponse.text).data.bikes

    const voiTrondheimResponse: request.Response = await request
        .get(`${functions.config().voi.url.trondheim}`)
        .set('Authorization', `Bearer ${voiSessionKey}`)
        .set('X-Voigbfs-Ext', 'Battery')
        .set('Accept', 'application/vnd.mds.provider+json;version=0.3')
    voiTrondheim = JSON.parse(voiTrondheimResponse.text).data.bikes

    return mapVoi(
        voiOslo
            .concat(voiTrondheim)
            .filter((v) => !v.is_disabled && !v.is_reserved),
    )
}

async function refreshVoiSessionKey() {
    console.log(`Refreshing ${Operator.VOI} session key..`)
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
        voiSessionKey = JSON.parse(res.text).access_token
    } catch (err) {
        logError(Operator.VOI, err, 'Failed to refresh session key')
    }
}

async function getZvippScooters() {
    if (toggles().zvipp === 'off') {
        console.log(`${capitalizeFirstLetter(Operator.ZVIPP)} is toggled off`)
        return []
    }
    try {
        const zvippDrammenResponse: request.Response = await request.get(
            functions.config().zvipp.url.drammen,
        )
        const zvippDrammen: Zvipp[] = JSON.parse(zvippDrammenResponse.text).data
            .bikes

        return mapZvipp(
            zvippDrammen.filter((z) => !z.is_disabled && !z.is_reserved),
        )
    } catch (err) {
        logError(Operator.ZVIPP, err)
        return []
    }
}

async function getLimeScooters() {
    if (toggles().lime === 'off') {
        console.log(`${capitalizeFirstLetter(Operator.LIME)} is toggled off`)
        return []
    }
    try {
        const limeOsloResponse: request.Response = await request

            .get(functions.config().lime.url.oslo)
            .set('Authorization', 'Bearer ' + functions.config().lime.api.token)
        const limeOslo: Lime[] = JSON.parse(limeOsloResponse.text).data.bikes

        return mapLime(limeOslo.filter((z) => !z.is_disabled && !z.is_reserved))
    } catch (err) {
        logError(Operator.LIME, err)
        return []
    }
}

async function getBoltScooters() {
    if (toggles().bolt === 'off') {
        console.log(`${capitalizeFirstLetter(Operator.BOLT)} is toggled off`)
        return []
    }

    try {
        return await boltRequests()
    } catch (err) {
        if (err && err.status === 401) {
            try {
                await refreshBoltTokens()
                return await boltRequests()
            } catch (e) {
                logError(Operator.BOLT, err)
                return []
            }
        } else {
            logError(Operator.BOLT, err)
            return []
        }
    }
}

async function boltRequests() {
    return [
        ...mapBolt(
            await boltRequest(functions.config().bolt.url.oslo, boltOsloToken),
            BoltOperatorCity.OSLO,
        ),
        ...mapBolt(
            await boltRequest(
                functions.config().bolt.url.lillestrom,
                boltLillestromToken,
            ),
            BoltOperatorCity.LILLESTROM,
        ),
        ...mapBolt(
            await boltRequest(
                functions.config().bolt.url.fredrikstad,
                boltFredrikstadToken,
            ),
            BoltOperatorCity.FREDRIKSTAD,
        ),
        ...mapBolt(
            await boltRequest(
                functions.config().bolt.url.bergen,
                boltBergenToken,
            ),
            BoltOperatorCity.BERGEN,
        ),
    ]
}

async function boltRequest(url: string, token: string): Promise<Bolt[]> {
    const boltResponse: request.Response = await request
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json')
    const bolt: Bolt[] = JSON.parse(boltResponse.text).data.bikes
    return bolt.filter((v) => !v.is_disabled && !v.is_reserved)
}

async function refreshBoltTokens() {
    console.log(`Refreshing ${Operator.BOLT} tokens`)
    try {
        boltOsloToken = await refreshBoltToken(
            functions.config().bolt.api.oslo.user,
            functions.config().bolt.api.oslo.pass,
        )
        boltLillestromToken = await refreshBoltToken(
            functions.config().bolt.api.lillestrom.user,
            functions.config().bolt.api.lillestrom.pass,
        )
        boltFredrikstadToken = await refreshBoltToken(
            functions.config().bolt.api.fredrikstad.user,
            functions.config().bolt.api.fredrikstad.pass,
        )
        boltBergenToken = await refreshBoltToken(
            functions.config().bolt.api.bergen.user,
            functions.config().bolt.api.bergen.pass,
        )
    } catch (err) {
        logError(Operator.BOLT, err, 'Failed to refresh session key')
    }
}

async function refreshBoltToken(user: string, pass: string): Promise<string> {
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
