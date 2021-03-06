import { Tier, Vehicle, Voi, Zvipp, Lime, Bolt } from './interfaces'
import { BoltOperatorCity, getNeTExId, Operator } from './operators'

export function mapVoi(voiScooters: Voi[]): Vehicle[] {
    return voiScooters.map((v: Voi) => ({
        id: getNeTExId(v.bike_id, Operator.VOI),
        operator: Operator.VOI.toLowerCase(),
        lat: v.lat,
        lon: v.lon,
        battery: v.battery,
    }))
}

export function mapTier(tierScooters: Tier[]): Vehicle[] {
    return tierScooters.map((t: Tier) => ({
        id: getNeTExId(t.id, Operator.TIER),
        operator: Operator.TIER.toLowerCase(),
        lat: t.attributes.lat,
        lon: t.attributes.lng,
        code: t.attributes.code.toString(),
        battery: t.attributes.batteryLevel,
    }))
}

export function mapZvipp(zvippScooters: Zvipp[]): Vehicle[] {
    return zvippScooters.map((z: Zvipp) => ({
        id: getNeTExId(z.bike_id.toString(), Operator.ZVIPP),
        operator: Operator.ZVIPP.toLowerCase(),
        lat: Number(z.lat),
        lon: Number(z.lon),
        code: z['qr-code'],
        battery: z.battery,
    }))
}

export function mapLime(limeScooters: Lime[]): Vehicle[] {
    return limeScooters.map((l: Lime) => ({
        id: getNeTExId(l.bike_id.toString(), Operator.LIME),
        operator: Operator.LIME.toLowerCase(),
        lat: Number(l.lat),
        lon: Number(l.lon),
        batteryLevel: l.battery_level,
        rental_uris: l.rental_uris,
    }))
}

export function mapBolt(
    boltScooters: Bolt[],
    operatorCity: BoltOperatorCity,
): Vehicle[] {
    return boltScooters.map((b: Bolt) => ({
        id: getNeTExId(b.bike_id.toString(), Operator.BOLT),
        operator: Operator.BOLT.toLowerCase(),
        city: operatorCity.toLowerCase(),
        lat: Number(b.lat),
        lon: Number(b.lon),
        rental_uris: b.rental_uris,
    }))
}
