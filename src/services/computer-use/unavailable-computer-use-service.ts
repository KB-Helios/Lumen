import type {ComputerUseService} from './computer-use-service';
import {unavailableComputerUseHealth, type ComputerUseEvent} from './computer-use.types';

export class UnavailableComputerUseService implements ComputerUseService {
  async health() {return unavailableComputerUseHealth();}
  async targets() {return [];}
  stream(): AsyncIterable<ComputerUseEvent> {
    throw new Error('Computer Use requires the native Lumen app. Desktop control is unavailable in this preview.');
  }
  async respond(): Promise<void> {throw new Error('Computer Use is unavailable in this browser preview.');}
  async stop(): Promise<void> {throw new Error('Native Stop is unavailable in this browser preview.');}
}
