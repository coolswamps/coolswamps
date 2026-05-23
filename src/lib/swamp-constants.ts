/**
 * Shared swamp taxonomy constants.
 * Import from here in pages/components — NOT from content/config.ts directly.
 * content/config.ts imports from here for the Zod schema.
 */

export const US_STATES = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut',
  'Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa',
  'Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan',
  'Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada',
  'New Hampshire','New Jersey','New Mexico','New York','North Carolina',
  'North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island',
  'South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont',
  'Virginia','Washington','West Virginia','Wisconsin','Wyoming',
  'Washington D.C.','Puerto Rico','U.S. Virgin Islands',
] as const;

export const TERRAIN_TYPES = [
  'bottomland-forest','bog','peat-bog','mire','fen','cypress-dome',
  'cypress-swamp','pocosin','mangrove','prairie-pothole','freshwater-marsh',
  'saltwater-marsh','vernal-pool','shrub-carr','tidal-swamp',
  'floodplain-forest','Carolina-bay','wet-prairie','other',
] as const;

export const HABITAT_TYPES = [
  'forested-wetland','shrub-wetland','emergent-wetland','aquatic-bed',
  'unconsolidated-bottom','unconsolidated-shore','moss-lichen-wetland','other',
] as const;

export const SOIL_TYPES = [
  'histosol','hydric','peat','muck','clay','sandy-loam',
  'silt-loam','alluvial','marl','organic','other',
] as const;

export const WATER_TYPES = [
  'blackwater','clearwater','whitewater','tidal','standing-water',
  'slow-moving','seasonal','perennial','intermittent','other',
] as const;

export const TOPOGRAPHY = [
  'flat','gentle-slope','depression','floodplain','terrace',
  'karst','coastal','riverine','lacustrine','palustrine','other',
] as const;

export const ACTIVITIES = [
  'hiking','bushwhacking','kayaking','canoeing','paddling',
  'birding','wildlife-watching','photography','videography',
  'fishing','frogging','hunting','foraging','swimming','wading',
  'camping','overnight-backpacking','botanizing','herping',
  'insect-collecting','scientific-research','other',
] as const;

export const DIFFICULTY = ['easy','moderate','difficult','expert'] as const;
export const SEASONS    = ['spring','summer','fall','winter','year-round'] as const;
export const STATUS     = ['visited','want-to-visit'] as const;

// Derived types
export type TerrainType  = typeof TERRAIN_TYPES[number];
export type HabitatType  = typeof HABITAT_TYPES[number];
export type SoilType     = typeof SOIL_TYPES[number];
export type ActivityType = typeof ACTIVITIES[number];
export type SwampStatus  = typeof STATUS[number];
