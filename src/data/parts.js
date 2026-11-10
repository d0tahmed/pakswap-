// Modification catalogue and default build configuration.

export const PAINT_PRESETS = [
  { name: 'Superwhite', hex: '#f2f2ee' },
  { name: 'Silky Silver', hex: '#c3c7cb' },
  { name: 'Graphite', hex: '#4a4e54' },
  { name: 'Midnight Black', hex: '#141518' },
  { name: 'Crimson', hex: '#b3121f' },
  { name: 'Ruby Wine', hex: '#5c0f1c' },
  { name: 'Karachi Sea Blue', hex: '#1f5d8c' },
  { name: 'Indus Teal', hex: '#11847e' },
  { name: 'Margalla Green', hex: '#2f5d34' },
  { name: 'Saffron', hex: '#f0a218' },
  { name: 'Mustard', hex: '#c9a227' },
  { name: 'Thar Sand', hex: '#c8b28a' },
  { name: 'Mango Orange', hex: '#e2621b' },
  { name: 'Lahore Rose', hex: '#d9617f' },
  { name: 'Royal Purple', hex: '#4b2a7a' },
  { name: 'Lime Rush', hex: '#8cc63f' },
];

export const FINISHES = [
  { id: 'gloss', label: 'Gloss' },
  { id: 'metallic', label: 'Metallic' },
  { id: 'pearl', label: 'Pearl' },
  { id: 'matte', label: 'Matte' },
  { id: 'satin', label: 'Satin' },
  { id: 'candy', label: 'Candy' },
  { id: 'chrome', label: 'Chrome' },
];

export const LIVERIES = [
  { id: 'none', label: 'Solid' },
  { id: 'stripes', label: 'Racing stripes' },
  { id: 'side', label: 'Side stripe' },
  { id: 'truckart', label: 'Truck art' },
  { id: 'carbon', label: 'Carbon wrap' },
  { id: 'camo', label: 'Camo' },
  { id: 'checker', label: 'Checker' },
];

export const RIM_STYLES = [
  { id: 'stock', label: 'Factory' },
  { id: 'five', label: '5-spoke' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'multi', label: 'Multi-spoke' },
  { id: 'y', label: 'Y-spoke' },
  { id: 'dish', label: 'Deep dish' },
  { id: 'turbine', label: 'Aero turbine' },
  { id: 'offroad', label: 'Beadlock' },
];

export const RIM_COLORS = [
  { name: 'Silver', hex: '#c9cdd2' },
  { name: 'Gunmetal', hex: '#4b4f55' },
  { name: 'Black', hex: '#1b1c1f' },
  { name: 'Bronze', hex: '#8a6a3d' },
  { name: 'Gold', hex: '#c9a54a' },
  { name: 'White', hex: '#eeeeea' },
  { name: 'Red', hex: '#b5121b' },
  { name: 'Chrome', hex: '#f4f4f4', chrome: true },
];

export const CALIPER_COLORS = [
  { name: 'Stock', hex: '#3a3d42' },
  { name: 'Red', hex: '#d4202a' },
  { name: 'Yellow', hex: '#f2c21b' },
  { name: 'Blue', hex: '#1f6fd1' },
  { name: 'Green', hex: '#1f9d55' },
  { name: 'Orange', hex: '#ee6a1a' },
];

export const UNDERGLOW = [
  { name: 'Off', hex: null },
  { name: 'Ice', hex: '#5fd4ff' },
  { name: 'Emerald', hex: '#22e08a' },
  { name: 'Magenta', hex: '#ff3fb4' },
  { name: 'Amber', hex: '#ffb020' },
  { name: 'Violet', hex: '#8a5cff' },
];

// Option groups. Effects are interpreted in sim/analysis.js.
export const OPTIONS = {
  exhaust: [
    { id: 'stock', label: 'Stock muffler', desc: 'Quiet and legal' },
    { id: 'sport', label: 'Sport cat-back', desc: 'Deeper note, small power gain' },
    { id: 'straight', label: 'Straight pipe', desc: 'Very loud, pops and crackles' },
  ],
  intake: [
    { id: 'stock', label: 'Stock airbox', desc: 'Factory filter' },
    { id: 'cai', label: 'Cold air intake', desc: 'More induction noise, +2%' },
    { id: 'itb', label: 'Individual throttle bodies', desc: 'NA only, race induction howl', naOnly: true },
  ],
  ecu: [
    { id: 'stock', label: 'Factory map', desc: 'Safe and smooth' },
    { id: 's1', label: 'Stage 1', desc: 'Remap only' },
    { id: 's2', label: 'Stage 2', desc: 'Remap with breathing mods' },
    { id: 's3', label: 'Stage 3', desc: 'Cams or bigger turbo, raised limiter' },
  ],
  fi: [
    { id: 'none', label: 'Factory', desc: 'As the engine came' },
    { id: 'turbo', label: 'Turbo kit', desc: 'Low boost, daily friendly' },
    { id: 'bigturbo', label: 'Big turbo', desc: 'Huge top end, real lag' },
    { id: 'sc', label: 'Supercharger', desc: 'Instant boost and whine' },
  ],
  nitrous: [
    { id: 'none', label: 'None' },
    { id: 'n35', label: '35 hp shot' },
    { id: 'n75', label: '75 hp shot' },
    { id: 'n150', label: '150 hp shot' },
  ],
  fuelsys: [
    { id: 'petrol', label: 'Petrol', desc: 'Factory fuel' },
    { id: 'cng', label: 'CNG kit', desc: 'Cheap per km, less power' },
    { id: 'lpg', label: 'LPG kit', desc: 'Cheaper than petrol, small loss' },
  ],
  gearbox: [
    { id: 'auto', label: 'Recommended' },
    { id: 'MT5', label: '5-speed manual' },
    { id: 'MT6', label: '6-speed manual' },
    { id: 'AT6', label: '6-speed automatic' },
    { id: 'CVT', label: 'CVT' },
    { id: 'DCT7', label: '7-speed dual clutch' },
    { id: 'SEQ6', label: '6-speed sequential' },
  ],
  gearing: [
    { id: 'short', label: 'Short', desc: 'Faster launch' },
    { id: 'balanced', label: 'Balanced', desc: 'Matched to power' },
    { id: 'tall', label: 'Tall', desc: 'Motorway cruising' },
  ],
  drive: [
    { id: 'auto', label: 'Recommended' },
    { id: 'FWD', label: 'FWD' },
    { id: 'RWD', label: 'RWD' },
    { id: 'AWD', label: 'AWD' },
  ],
  lsd: [
    { id: 'open', label: 'Open diff' },
    { id: 'helical', label: 'Helical LSD' },
    { id: 'clutch', label: 'Clutch-type LSD' },
  ],
  clutch: [
    { id: 'stock', label: 'Stock clutch' },
    { id: 'hd', label: 'Heavy-duty clutch and axles' },
  ],
  brakes: [
    { id: 'stock', label: 'Stock', desc: 'Factory pads and discs' },
    { id: 'pads', label: 'Sport pads', desc: 'Better bite and fade' },
    { id: 'bbk', label: 'Big brake kit', desc: '4-piston calipers, bigger discs' },
    { id: 'ceramic', label: 'Carbon-ceramic', desc: 'Light and fade free' },
  ],
  suspension: [
    { id: 'stock', label: 'Stock', desc: 'Built for our roads' },
    { id: 'springs', label: 'Lowering springs', desc: '35 mm lower' },
    { id: 'coilovers', label: 'Coilovers', desc: 'Adjustable height' },
    { id: 'air', label: 'Air suspension', desc: 'Raise for speed breakers' },
    { id: 'lift', label: 'Lift kit', desc: '50 mm higher' },
  ],
  weight: [
    { id: 'stock', label: 'Full interior' },
    { id: 'light', label: 'Remove spare and tools' },
    { id: 'seats', label: 'Bucket seats, light battery' },
    { id: 'strip', label: 'Stripped interior' },
    { id: 'carbon', label: 'Stripped + carbon panels' },
  ],
  tyres: [
    { id: 'eco', label: 'Eco' },
    { id: 'standard', label: 'Standard' },
    { id: 'performance', label: 'Performance' },
    { id: 'semislick', label: 'Semi-slick' },
    { id: 'drag', label: 'Drag radial' },
    { id: 'at', label: 'All-terrain' },
  ],
  tyreWidth: [
    { id: 0, label: 'Stock width' },
    { id: 1, label: '+10 mm' },
    { id: 2, label: '+20 mm' },
    { id: 3, label: '+40 mm' },
  ],
  cooling: [
    { id: 'stock', label: 'Stock' },
    { id: 'radiator', label: 'Aluminium radiator' },
    { id: 'full', label: 'Radiator + oil cooler' },
  ],
  spoiler: [
    { id: 'none', label: 'None' },
    { id: 'lip', label: 'Lip' },
    { id: 'ducktail', label: 'Ducktail' },
    { id: 'roof', label: 'Roof spoiler' },
    { id: 'wing', label: 'GT wing' },
  ],
  hood: [
    { id: 'stock', label: 'Stock' },
    { id: 'vented', label: 'Vented' },
    { id: 'scoop', label: 'Scoop' },
    { id: 'carbon', label: 'Carbon' },
  ],
  roofAcc: [
    { id: 'none', label: 'Clean roof' },
    { id: 'rack', label: 'Roof rack' },
    { id: 'box', label: 'Roof box' },
    { id: 'lightbar', label: 'LED light bar' },
    { id: 'luggage', label: 'Shaadi luggage' },
  ],
  tips: [
    { id: 'auto', label: 'Match exhaust' },
    { id: 'single', label: 'Single' },
    { id: 'dual', label: 'Dual' },
    { id: 'quad', label: 'Quad' },
    { id: 'center', label: 'Centre' },
  ],
  headlight: [
    { id: 'white', label: 'Cool white' },
    { id: 'warm', label: 'Halogen warm' },
    { id: 'ice', label: 'Ice blue' },
  ],
};

export function defaultConfig(car) {
  const d = car.defaults || {};
  const rim = d.rim || 'stock';
  return {
    engineId: car.engine,
    // performance
    exhaust: d.exhaust || 'stock', intake: 'stock', ecu: 'stock', fi: 'none', nitrous: 'none', fuelsys: 'petrol',
    gearbox: 'auto', gearing: 'balanced', drive: 'auto', lsd: 'open', clutch: 'stock', cooling: 'stock',
    brakes: 'stock', suspension: 'stock', rideHeight: 0, weight: 'stock',
    tyres: d.tyres || 'standard', tyreWidth: 0,
    // wheels
    rimStyle: rim, rimSize: stockRim(car), rimColor: d.rimColor || '#c9cdd2', caliper: d.caliper || '#3a3d42',
    // paint
    paint: car.color, finish: 'metallic', roof: car.roof || null, livery: 'none', liveryColor: '#f2f2ee', tint: 25,
    plate: plateFor(car),
    // body
    lip: !!d.lip, skirts: !!d.skirts, diffuser: !!d.diffuser, spoiler: d.spoiler || 'none', hood: 'stock',
    widebody: false, roofAcc: 'none', bullbar: false, snorkel: false, mudflaps: false, towhook: false, cage: false,
    tips: d.tips || 'auto', headlight: 'white', underglow: null,
  };
}

export function stockRim(car) {
  const m = /R(\d+)/.exec(car.tyre);
  return m ? +m[1] : 15;
}

function plateFor(car) {
  const codes = ['LEC', 'BKR', 'KHI', 'ICT', 'LEA', 'RIK', 'PSH', 'QTA'];
  let h = 0; for (const ch of car.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${codes[h % codes.length]} ${(h % 9000) + 1000}`;
}

// Fields that only change the look; edits to these skip the physics recompute.
export const VISUAL_KEYS = new Set(['paint', 'finish', 'roof', 'livery', 'liveryColor', 'tint', 'plate', 'rimColor', 'caliper',
  'headlight', 'underglow', 'tips']);
