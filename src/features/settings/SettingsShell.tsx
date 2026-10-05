import {useEffect, useLayoutEffect, useRef, type ReactNode} from 'react';

import {motion} from 'motion/react';
import {TabPanel, Tabs} from 'react-aria-components';

import {useLumenMotion} from '../../design-system/MotionProvider';
import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenIconButton} from '../../design-system/primitives/LumenIconButton';
import {LumenSurface} from '../../design-system/primitives/LumenSurface';
import {LumenText} from '../../design-system/primitives/LumenText';
import {settingsPages, SettingsNav} from './SettingsNav';
import {PersistenceNotice} from './components/PersistenceNotice';
import {AppearancePage} from './pages/AppearancePage';
import {AgentGatewayPage} from './pages/AgentGatewayPage';
import {ActivityPage} from './pages/ActivityPage';
import {ComputerUsePage} from './pages/ComputerUsePage';
import {DiagnosticsPage} from './pages/DiagnosticsPage';
import {GeneralPage} from './pages/GeneralPage';
import {IndexedRootsPage} from './pages/IndexedRootsPage';
import {LocalAiPage} from './pages/LocalAiPage';
import {PrivacyPage} from './pages/PrivacyPage';
import {SearchPage} from './pages/SearchPage';
import {settingsPageIdSchema, type SettingsPageId} from './settings.schema';
import {useSettingsStore} from './settings.store';

export interface SettingsShellProps {
  onClose(): void;
  pages?: Partial<Record<SettingsPageId, ReactNode>>;
}

function defaultPageContent(page: SettingsPageId) {
  switch (page) {
    case 'general': return <GeneralPage />;
    case 'appearance': return <AppearancePage />;
    case 'indexed-roots': return <IndexedRootsPage />;
    case 'search': return <SearchPage />;
    case 'local-ai': return <LocalAiPage />;
    case 'agent-gateway': return <AgentGatewayPage />;
    case 'computer-use': return <ComputerUsePage />;
    case 'activity': return <ActivityPage />;
    case 'privacy': return <PrivacyPage />;
    case 'diagnostics': return <DiagnosticsPage />;
    default: return null;
  }
}

export function SettingsShell({onClose, pages}: SettingsShellProps) {
  const {pageDuration, reducedMotion} = useLumenMotion();
  const activePage = useSettingsStore((state) => state.activePage);
  const hydrate = useSettingsStore((state) => state.hydrate);
  const setActivePage = useSettingsStore((state) => state.setActivePage);
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const page = settingsPages.find((item) => item.id === activePage) ?? settingsPages[0];

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    shellRef.current?.querySelector<HTMLElement>('[role="tab"][data-selected="true"]')?.focus();
  }, []);

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [page.id]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const handleSelectionChange = (key: React.Key) => {
    const result = settingsPageIdSchema.safeParse(String(key));
    if (result.success) {
      setActivePage(result.data);
    }
  };

  return (
    <LumenSurface
      ref={shellRef}
      aria-label="Lumen settings"
      className="grid h-full min-h-0 min-w-0 w-full grid-rows-[54px_minmax(0,1fr)] overflow-hidden rounded-surface"
      material="mica"
    >
      <header data-tauri-drag-region className="flex min-w-0 items-center justify-between gap-[12px] border-b border-border-subtle px-[20px]">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-[12px]">
          <LumenText weight="semibold">Lumen</LumenText>
          <LumenText tone="tertiary" variant="meta">Settings</LumenText>
        </div>
        <LumenIconButton aria-label="Close settings" data-settings-close-action="true" size="small" variant="quiet" onPress={onClose}>
          <LumenUiIcon name="close" size="small" />
        </LumenIconButton>
      </header>
      <Tabs
        orientation="vertical"
        selectedKey={page.id}
        onSelectionChange={handleSelectionChange}
        className="grid min-h-0 min-w-0 grid-cols-[clamp(148px,30%,260px)_minmax(0,1fr)]"
      >
        <div className="min-h-0 min-w-0 overflow-y-auto border-r border-border-subtle bg-surface-inset"><SettingsNav /></div>
        <main ref={contentRef} aria-label="Settings content" className="min-h-0 min-w-0 overflow-y-auto" data-testid="settings-content">
          <TabPanel id={page.id} className="min-w-0 outline-none">
            <motion.div
              key={page.id}
              className="mx-auto grid min-w-0 w-full max-w-[760px] content-start gap-[24px] px-[20px] py-[24px] [overflow-wrap:anywhere]"
              initial={{opacity: 0, transform: `translateY(${reducedMotion ? 0 : 6}px)`}}
              animate={{opacity: 1, transform: 'translateY(0px)'}}
              transition={{duration: pageDuration}}
            >
              <div className="grid min-w-0 gap-[8px]">
                <LumenText as="h1" variant="title">{page.label}</LumenText>
                <LumenText tone="secondary">{page.description}</LumenText>
              </div>
              <PersistenceNotice />
              {pages?.[page.id] ?? defaultPageContent(page.id) ?? (
                <div className="min-w-0 rounded-surface border border-border-subtle bg-surface-inset p-[16px]">
                  <LumenText tone="secondary">
                    Lumen keeps this area focused on the controls that belong to {page.label.toLowerCase()}.
                  </LumenText>
                </div>
              )}
            </motion.div>
          </TabPanel>
        </main>
      </Tabs>
    </LumenSurface>
  );
}
