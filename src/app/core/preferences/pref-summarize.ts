const HEX_COLOR_PATTERN = /^#([0-9a-f]{6})$/i;
// Keep near-neutral defaults like #3e3d32 out of noisy hue buckets.
const LOW_SATURATION_THRESHOLD = 0.11;

export type ColorBucket =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'gray'
  | 'custom';

interface HslColor {
  hue: number;
  saturation: number;
  lightness: number;
}

/**
 * Buckets a #rrggbb color into a closed telemetry enum. Hue ranges use
 * deterministic shared boundaries: red [340, 360) + [0, 20], orange
 * (20, 45], yellow (45, 65], green (65, 150], teal (150, 200], blue
 * (200, 255], purple (255, 290], and pink (290, 340).
 */
export function bucketColorHex(hex: string): ColorBucket {
  if (typeof hex !== 'string') {
    return 'custom';
  }
  const match = HEX_COLOR_PATTERN.exec(hex);
  const hexDigits = match?.[1];
  if (!hexDigits) {
    return 'custom';
  }

  const redChannel = Number.parseInt(hexDigits.slice(0, 2), 16);
  const greenChannel = Number.parseInt(hexDigits.slice(2, 4), 16);
  const blueChannel = Number.parseInt(hexDigits.slice(4, 6), 16);
  if ([redChannel, greenChannel, blueChannel].some(Number.isNaN)) {
    return 'custom';
  }

  const color = toHsl(redChannel, greenChannel, blueChannel);
  if (color.saturation < LOW_SATURATION_THRESHOLD) {
    return 'gray';
  }
  return bucketHue(color.hue);
}

export type FontSizeBucket = '<10' | '10-12' | '13-14' | '15-16' | '17-20' | '>20';

export function bucketFontSize(value: number): FontSizeBucket {
  if (Number.isNaN(value) || value < 10) {
    return '<10';
  }
  if (value <= 12) {
    return '10-12';
  }
  if (value <= 14) {
    return '13-14';
  }
  if (value <= 16) {
    return '15-16';
  }
  if (value <= 20) {
    return '17-20';
  }
  return '>20';
}

export type DepthBucket = '0' | '1' | '2' | '3-5' | '6-10' | '>10';

export function bucketDepth(value: number): DepthBucket {
  if (Number.isNaN(value) || value <= 0) {
    return '0';
  }
  if (value <= 1) {
    return '1';
  }
  if (value <= 2) {
    return '2';
  }
  if (value <= 5) {
    return '3-5';
  }
  if (value <= 10) {
    return '6-10';
  }
  return '>10';
}

export type TabSizeBucket = '2' | '4' | 'other';

export function bucketTabSize(value: number): TabSizeBucket {
  if (value === 2) {
    return '2';
  }
  if (value === 4) {
    return '4';
  }
  return 'other';
}

function toHsl(redChannel: number, greenChannel: number, blueChannel: number): HslColor {
  const redNormalized = redChannel / 255;
  const greenNormalized = greenChannel / 255;
  const blueNormalized = blueChannel / 255;
  const maxChannel = Math.max(redNormalized, greenNormalized, blueNormalized);
  const minChannel = Math.min(redNormalized, greenNormalized, blueNormalized);
  const chroma = maxChannel - minChannel;
  const lightness = (maxChannel + minChannel) / 2;

  if (chroma === 0) {
    return { hue: 0, saturation: 0, lightness };
  }

  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (maxChannel === redNormalized) {
    hue = 60 * (((greenNormalized - blueNormalized) / chroma) % 6);
  } else if (maxChannel === greenNormalized) {
    hue = 60 * ((blueNormalized - redNormalized) / chroma + 2);
  } else {
    hue = 60 * ((redNormalized - greenNormalized) / chroma + 4);
  }
  if (hue < 0) {
    hue += 360;
  }
  return { hue, saturation, lightness };
}

function bucketHue(hue: number): ColorBucket {
  if (hue >= 340 || hue <= 20) {
    return 'red';
  }
  if (hue <= 45) {
    return 'orange';
  }
  if (hue <= 65) {
    return 'yellow';
  }
  if (hue <= 150) {
    return 'green';
  }
  if (hue <= 200) {
    return 'teal';
  }
  if (hue <= 255) {
    return 'blue';
  }
  if (hue <= 290) {
    return 'purple';
  }
  return 'pink';
}
