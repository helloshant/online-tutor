import type { VehicleType } from "./fares";

export type Captain = {
  id: string;
  name: string;
  phone: string;
  rating: number;
  trips: number;
  vehicleModel: string;
  vehicleNumber: string;
  avatar: string;
};

const FIRST = ["Ravi", "Suresh", "Manjunath", "Imran", "Prakash", "Arjun", "Kiran", "Naveen", "Lakshmi", "Faisal", "Deepak", "Anitha", "Venkatesh", "Rahul"];
const LAST = ["K", "R", "S", "M", "Gowda", "Reddy", "Khan", "Nair", "Shetty", "Rao"];
const MODELS: Record<VehicleType, string[]> = {
  bike: ["Honda Activa 6G", "TVS Jupiter", "Bajaj Pulsar 150", "Hero Splendor+", "Honda Shine"],
  auto: ["Bajaj RE Compact", "Piaggio Ape City", "TVS King Deluxe"],
  cab: ["Maruti Swift Dzire", "Hyundai Aura", "Tata Tigor", "Honda Amaze"],
  cab_premium: ["Toyota Etios", "Honda City", "Hyundai Verna", "Maruti Ciaz"],
};
const AVATARS = ["👨🏽", "👨🏾", "👩🏽", "🧔🏽", "👨🏻", "👩🏾"];

const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

export function randomCaptain(type: VehicleType): Captain {
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const plate = `KA ${String(1 + Math.floor(Math.random() * 60)).padStart(2, "0")} ${pick([...letters])}${pick([...letters])} ${digits(4)}`;
  return {
    id: crypto.randomUUID(),
    name: `${pick(FIRST)} ${pick(LAST)}`,
    phone: `+91 9${digits(4)} ${digits(5)}`,
    rating: Math.round((4.3 + Math.random() * 0.7) * 10) / 10,
    trips: 200 + Math.floor(Math.random() * 6000),
    vehicleModel: pick(MODELS[type]),
    vehicleNumber: plate,
    avatar: pick(AVATARS),
  };
}

export function randomOtp(): string {
  return digits(4);
}
