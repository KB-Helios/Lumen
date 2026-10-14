import {createContext} from 'react';
import {semanticSearchService} from '../../services/search/semantic-search-service';

export const SemanticSearchContext = createContext(semanticSearchService);
