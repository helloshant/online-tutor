import type { LatLng } from "@shared/geo";

export type RideMapProps = {
  center: LatLng;
  pickup?: LatLng | null;
  drop?: LatLng | null;
  route?: LatLng[] | null;
  approach?: LatLng[] | null;
  vehicle?: { position: LatLng; icon: string } | null;
  nearby?: { position: LatLng; icon: string }[];
  onPress?: (p: LatLng) => void;
  /** Extra bottom inset so fitted routes aren't hidden under the sheet. */
  bottomInset?: number;
};
