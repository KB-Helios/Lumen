import {createContext} from 'react';
import type {WorkflowServices} from './workflow-runner';
export const WorkflowServicesContext = createContext<WorkflowServices | null>(null);
