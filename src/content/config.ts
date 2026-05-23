import { defineCollection, z } from 'astro:content';

// ─── Shared enums ────────────────────────────────────────────────────────────

const US_STATES = [
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

const TERRAIN_TYPES = [
  'bottomland-forest',
  'bog',
  'peat-bog',
  'mire',
  'fen',
  'cypress-dome',
  'cypress-swamp',
  'pocosin',
  'mangrove',
  'prairie-pothole',
  'freshwater-marsh',
  'saltwater-marsh',
  'vernal-pool',
  'shrub-carr',
  'tidal-swamp',
  'floodplain-forest',
  'Carolina-bay',
  'wet-prairie',
  'other',
] as const;

const HABITAT_TYPES = [
  'forested-wetland',
  'shrub-wetland',
  'emergent-wetland',
  'aquatic-bed',
  'unconsolidated-bottom',
  'unconsolidated-shore',
  'moss-lichen-wetland',
  'other',
] as const;

const SOIL_TYPES = [
  'histosol',
  'hydric',
  'peat',
  'muck',
  'clay',
  'sandy-loam',
  'silt-loam',
  'alluvial',
  'marl',
  'organic',
  'other',
] as const;

const WATER_TYPES = [
  'blackwater',
  'clearwater',
  'whitewater',
  'tidal',
  'standing-water',
  'slow-moving',
  'seasonal',
  'perennial',
  'intermittent',
  'other',
] as const;

const TOPOGRAPHY = [
  'flat',
  'gentle-slope',
  'depression',
  'floodplain',
  'terrace',
  'karst',
  'coastal',
  'riverine',
  'lacustrine',
  'palustrine',
  'other',
] as const;

const ACTIVITIES = [
  'hiking',
  'bushwhacking',
  'kayaking',
  'canoeing',
  'paddling',
  'birding',
  'wildlife-watching',
  'photography',
  'videography',
  'fishing',
  'frogging',
  'hunting',
  'foraging',
  'swimming',
  'wading',
  'camping',
  'overnight-backpacking',
  'botanizing',
  'herping',
  'insect-collecting',
  'scientific-research',
  'other',
] as const;

const DIFFICULTY = ['easy', 'moderate', 'difficult', 'expert'] as const;
const SEASONS    = ['spring', 'summer', 'fall', 'winter', 'year-round'] as const;
const STATUS     = ['visited', 'want-to-visit'] as const;

// ─── Swamp schema ─────────────────────────────────────────────────────────────

const swampSchema = z.object({
  // Identity
  name:        z.string().min(1).max(200),
  status:      z.enum(STATUS),

  // Location
  coordinates: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  state:       z.enum(US_STATES),
  county:      z.string().min(1).max(100),
  country:     z.string().default('USA'),
  address:     z.string().optional(),

  // Description
  description:  z.string().max(5000).optional(),
  access_notes: z.string().max(2000).optional(),
  wildlife_notes: z.string().max(2000).optional(),
  historical_notes: z.string().max(2000).optional(),

  // Physical characteristics
  area_acres:    z.number().positive().optional(),
  elevation_ft:  z.number().optional(),
  depth_ft_max:  z.number().positive().optional(),

  // Tags
  tags: z.object({
    terrain:    z.array(z.enum(TERRAIN_TYPES)).default([]),
    habitat:    z.array(z.enum(HABITAT_TYPES)).default([]),
    soil:       z.array(z.enum(SOIL_TYPES)).default([]),
    water_type: z.array(z.enum(WATER_TYPES)).default([]),
    topography: z.array(z.enum(TOPOGRAPHY)).default([]),
    activities: z.array(z.enum(ACTIVITIES)).default([]),
    vegetation: z.array(z.string().max(100)).default([]),
    custom:     z.array(z.string().max(50)).default([]),
  }).default({}),

  // Visit info
  difficulty:   z.enum(DIFFICULTY).optional(),
  best_season:  z.array(z.enum(SEASONS)).default([]),

  // Media
  photos: z.array(z.object({
    filename: z.string(),
    caption:  z.string().max(500).optional(),
    credit:   z.string().max(200).optional(),
  })).default([]),

  // Meta
  submitted_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  last_updated:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verified:       z.boolean().default(false),
});

// ─── Export collection ────────────────────────────────────────────────────────

export const collections = {
  swamps: defineCollection({
    type: 'data',
    schema: swampSchema,
  }),
};

// ─── Export types for use across the site ────────────────────────────────────

export type SwampEntry = z.infer<typeof swampSchema>;
export type TerrainType  = typeof TERRAIN_TYPES[number];
export type HabitatType  = typeof HABITAT_TYPES[number];
export type SoilType     = typeof SOIL_TYPES[number];
export type ActivityType = typeof ACTIVITIES[number];
export type SwampStatus  = typeof STATUS[number];
export {
  US_STATES, TERRAIN_TYPES, HABITAT_TYPES, SOIL_TYPES,
  WATER_TYPES, TOPOGRAPHY, ACTIVITIES, DIFFICULTY, SEASONS, STATUS
};
