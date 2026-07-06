// Curated adjectives for agent names (PascalCase format)
export const adjectives = [
  'Able', 'Agile', 'Artful', 'Avid', 'Balanced', 'Brave', 'Bright', 'Brisk',
  'Calm', 'Clear', 'Clever', 'Crisp', 'Daring', 'Diligent', 'Deft', 'Deep',
  'Dynamic', 'Eager', 'Earnest', 'Elegant', 'Energetic', 'Fair', 'Faithful',
  'Fertile', 'Fierce', 'Firm', 'Fleet', 'Frank', 'Fresh', 'Friendly', 'Frisky',
  'Gentle', 'Giant', 'Gifted', 'Global', 'Golden', 'Good', 'Grace', 'Grand', 'Green',
];

// Curated nouns for agent names (PascalCase format)
export const nouns = [
  'Anchor', 'Arrow', 'Beacon', 'Bear', 'Beast', 'Bell', 'Blade', 'Blaze',
  'Bridge', 'Bronze', 'Brook', 'Builder', 'Buzz', 'Castle', 'Cedar', 'Chain',
  'Charm', 'Chase', 'Cliff', 'Cloud', 'Coast', 'Compass', 'Crown', 'Crystal',
  'Current', 'Eagle', 'Earth', 'Echo', 'Edge', 'Element', 'Ember', 'Engine',
  'Fable', 'Falcon', 'Fate', 'Fawn', 'Feather', 'Fiber', 'Field', 'Fire',
  'Fisher', 'Flame', 'Flash', 'Fleet', 'Flight', 'Flint', 'Flood', 'Flow',
];

/**
 * Generate a unique agent name by combining a random adjective and noun.
 * Returns a PascalCase string like "GreenCastle".
 *
 * Randomness is generated at function call time, not at module load time.
 * The caller is responsible for enforcing uniqueness within a workspace.
 */
export function generateName(): string {
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  return randomAdj + randomNoun;
}
