import type {SearchResultKind} from '../../services/search/search.types';

export type FileKind = SearchResultKind;

export const fileKinds = [
  'folder',
  'pdf',
  'document',
  'spreadsheet',
  'presentation',
  'source',
  'image',
  'video',
  'audio',
  'archive',
  'executable',
  'model',
  'unknown',
  'app-content',
] as const satisfies readonly FileKind[];

