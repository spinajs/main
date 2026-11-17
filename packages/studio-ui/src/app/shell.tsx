import { SidebarNav, useNavTrail, type NavSection } from '@coderush/ckit-components/app-nav';
import { AppShell, AppShellContent, SidebarInset, Topbar, TopbarActions } from '@coderush/ckit-components/app-shell';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@coderush/ckit-components/breadcrumb';
import { Button } from '@coderush/ckit-components/button';
import { Link } from '@coderush/ckit-components/link';
import { Separator } from '@coderush/ckit-components/separator';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarTrigger } from '@coderush/ckit-components/sidebar';
import { PanelLeft, Search, Telescope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { useCapabilities } from './capabilities';
import { CommandPalette } from './command-palette';
import { PRODUCT_NAME, useNavSections } from './pages';

function StudioSidebar({ sections }: { sections: NavSection[] }) {
  const capabilities = useCapabilities();
  return (
    <Sidebar aria-label="Main" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <Link href="/">
                <Telescope aria-hidden />
                <span>
                  <strong>{PRODUCT_NAME}</strong>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarNav sections={sections} tooltips />
      </SidebarContent>
      <SidebarFooter>
        <small>{`v${capabilities.version} · tracing: ${capabilities.tracing.owner}`}</small>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function StudioTopbar({ sections, onSearch }: { sections: NavSection[]; onSearch: () => void }) {
  const page = useNavTrail(sections).at(-1);
  return (
    <Topbar>
      <SidebarTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Toggle the sidebar">
          <PanelLeft aria-hidden />
        </Button>
      </SidebarTrigger>
      <Separator orientation="vertical" role="none" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>{page ? <BreadcrumbLink href="/">{PRODUCT_NAME}</BreadcrumbLink> : <BreadcrumbPage>{PRODUCT_NAME}</BreadcrumbPage>}</BreadcrumbItem>
          {page ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{page.label}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
      <TopbarActions>
        <Button variant="ghost" size="sm" onClick={onSearch} aria-keyshortcuts="Control+K">
          <Search aria-hidden />
          Go to…
        </Button>
      </TopbarActions>
    </Topbar>
  );
}

export function AppLayout() {
  const sections = useNavSections();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <AppShell>
      <StudioSidebar sections={sections} />
      <SidebarInset>
        <StudioTopbar sections={sections} onSearch={() => setPaletteOpen(true)} />
        <AppShellContent>
          <Outlet />
        </AppShellContent>
      </SidebarInset>
      {paletteOpen ? <CommandPalette open onOpenChange={setPaletteOpen} sections={sections} /> : null}
    </AppShell>
  );
}
