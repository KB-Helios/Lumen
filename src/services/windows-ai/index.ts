import {isNativeRuntime} from '../ai/native-ai-service';
import {EdgeAiService} from '../edge-ai/edge-ai-service';
import {ComposedWindowsAiService} from './composed-windows-ai-service';
import {TauriWindowsAiService} from './tauri-windows-ai-service';
import {UnavailableWindowsAiService} from './unavailable-windows-ai-service';

export const windowsAiService = new ComposedWindowsAiService(isNativeRuntime() ? new TauriWindowsAiService() : new UnavailableWindowsAiService(), new EdgeAiService());
