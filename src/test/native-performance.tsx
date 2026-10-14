import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {NativePerformanceFixture} from './NativePerformanceFixture';
import '../design-system/global.css';

if (!import.meta.env.DEV || window.__LUMEN_NATIVE_PERFORMANCE__ !== true) throw new Error('Native performance fixture bootstrap required');
createRoot(document.getElementById('root')!).render(<StrictMode><NativePerformanceFixture /></StrictMode>);
