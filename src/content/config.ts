import { defineCollection, z } from 'astro:content';
import {
  US_STATES, TERRAIN_TYPES, HABITAT_TYPES, SOIL_TYPES,
  WATER_TYPES, TOPOGRAPHY, ACTIVITIES, DIFFICULTY, SEASONS, STATUS
} from '../lib/swamp-constants';

// ─── Swamp schema ──────────────────────────────────────────────────────────────

const swampSchema = z.object({
  // Identity
  name:    z.string().min(1).max(200),
  status:  z.enum(STATUS),

  // Location
  coordinates: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  state:   z.enum(US_STATES),
  county:  z.string().min(1).max(100),
  country: z.string().default('USA'),
  address: z.string().optional(),

  // Description
  description:      z.string().max(5000).optional(),
  access_notes:     z.string().max(2000).optional(),
  wildlife_notes:   z.string().max(2000).optional(),
  historical_notes: z.string().max(2000).optional(),

  // Physical
  area_acres:   z.number().positive().optional(),
  elevation_ft: z.number().optional(),
  depth_ft_max: z.number().positive().optional(),

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
  difficulty:  z.enum(DIFFICULTY).optional(),
  best_season: z.array(z.enum(SEASONS)).default([]),

  // Media
  photos: z.array(z.object({
    filename: z.string(),
    caption:  z.string().max(500).optional(),
    credit:   z.string().max(200).optional(),
  })).default([]),

  // Ratings (each 1–5, all optional)
  ratings: z.object({
    novelty:       z.number().int().min(1).max(5), // Novelty / Uniqueness
    accessibility: z.number().int().min(1).max(5), // Social Setting Quality
    habitat:       z.number().int().min(1).max(5), // Habitat Quality
  }).partial().optional(),

  // Meta
  submitted_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  last_updated:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verified:       z.boolean().default(false),
});

// ─── Export collection ─────────────────────────────────────────────────────────

export const collections = {
  swamps: defineCollection({
    type: 'data',
    schema: swampSchema,
  }),
};

export type SwampEntry = z.infer<typeof swampSchema>;
