import type { NavSection } from '@coderush/ckit-components/app-nav';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@coderush/ckit-components/command';

export function CommandPalette({ open, onOpenChange, sections }: { open: boolean; onOpenChange: (open: boolean) => void; sections: NavSection[] }) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label="Go to page">
      <CommandInput placeholder="Go to…" />
      <CommandList>
        <CommandEmpty>No page matches.</CommandEmpty>
        {sections.map((section) => (
          <CommandGroup key={section.label} heading={section.label}>
            {section.items.map((item) => (
              <CommandItem key={item.href} value={item.label} href={item.href} onSelect={() => onOpenChange(false)}>
                {item.icon}
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
