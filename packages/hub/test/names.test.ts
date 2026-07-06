import { describe, it, expect } from 'vitest';
import { generateName, adjectives, nouns } from '@shepherd/shared';

describe('names module', () => {
  describe('generateName()', () => {
    it('returns a non-empty string', () => {
      const name = generateName();
      expect(name).toBeTruthy();
      expect(typeof name).toBe('string');
    });

    it('returns a PascalCase string of the form WordWord', () => {
      const name = generateName();
      // Regex: starts with capital letter, followed by lowercase letters, then another capital letter, then lowercase letters
      expect(name).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
    });

    it('always returns a combination of a known adjective and noun', () => {
      // Test over 1000 invocations to ensure consistency
      for (let i = 0; i < 1000; i++) {
        const name = generateName();

        // Try to decompose the name into adjective + noun
        let found = false;
        for (const adj of adjectives) {
          for (const noun of nouns) {
            if (name === adj + noun) {
              found = true;
              break;
            }
          }
          if (found) break;
        }

        expect(found).toBe(true, `Generated name "${name}" does not match any adjective+noun combination (iteration ${i})`);
      }
    });

    it('produces varied results (different names on repeated calls)', () => {
      const names = new Set<string>();
      for (let i = 0; i < 100; i++) {
        names.add(generateName());
      }
      // With >1500 combinations, we should get many different names in 100 calls
      expect(names.size).toBeGreaterThan(50);
    });
  });

  describe('adjectives and nouns exports', () => {
    it('exports adjectives as an array', () => {
      expect(Array.isArray(adjectives)).toBe(true);
      expect(adjectives.length).toBeGreaterThan(0);
    });

    it('exports nouns as an array', () => {
      expect(Array.isArray(nouns)).toBe(true);
      expect(nouns.length).toBeGreaterThan(0);
    });

    it('has at least 40 adjectives', () => {
      expect(adjectives.length).toBeGreaterThanOrEqual(40);
    });

    it('has at least 40 nouns', () => {
      expect(nouns.length).toBeGreaterThanOrEqual(40);
    });

    it('all adjectives are PascalCase-friendly (start with uppercase)', () => {
      for (const adj of adjectives) {
        expect(adj[0]).toMatch(/[A-Z]/);
      }
    });

    it('all nouns are PascalCase-friendly (start with uppercase)', () => {
      for (const noun of nouns) {
        expect(noun[0]).toMatch(/[A-Z]/);
      }
    });

    it('all adjectives match the pattern [A-Z][a-z]+', () => {
      for (const adj of adjectives) {
        expect(adj).toMatch(/^[A-Z][a-z]+$/);
      }
    });

    it('all nouns match the pattern [A-Z][a-z]+', () => {
      for (const noun of nouns) {
        expect(noun).toMatch(/^[A-Z][a-z]+$/);
      }
    });

    it('creates >1500 possible combinations', () => {
      const combinations = adjectives.length * nouns.length;
      expect(combinations).toBeGreaterThan(1500);
    });
  });
});
