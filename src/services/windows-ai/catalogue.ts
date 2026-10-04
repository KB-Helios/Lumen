import {z} from 'zod';
import catalogue from './catalogue.json';
import {appContentMatchSchema, type AppContentMatch} from './windows-ai.types';

export const publicCatalogue = z.object({version: z.literal(1), items: z.array(appContentMatchSchema.omit({source: true}).extend({keywords: z.array(z.string())}))}).parse(catalogue).items;
export function searchPublicCatalogue(query: string): AppContentMatch[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return publicCatalogue.filter((item) => {
    const haystack = `${item.title} ${item.description} ${item.keywords.join(' ')}`.toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  }).map((item) => ({id: item.id, title: item.title, description: item.description, settingsPage: item.settingsPage, source: 'lexical'}));
}
export function resolvePublicMatches(matches: AppContentMatch[]): AppContentMatch[] {
  return matches.flatMap((match) => {
    const item = publicCatalogue.find((entry) => entry.id === match.id);
    return item ? [{id: item.id, title: item.title, description: item.description, settingsPage: item.settingsPage, source: match.source}] : [];
  });
}
