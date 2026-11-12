'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export type TabItem<T extends string> = { id: T; label: ReactNode; tabTestId?: string; panelTestId?: string };

/**
 * WAI-ARIA tabs with automatic activation: arrows, Home and End move the selection and the focus (roving tabindex).
 * Only the selected panel has content; the others stay as empty, hidden panels so every `aria-controls` resolves.
 */
export function Tabs<T extends string>({
  label,
  items,
  selected,
  onSelect,
  children,
  className,
}: {
  label: string;
  items: TabItem<T>[];
  selected: T;
  onSelect: (id: T) => void;
  /** Content of the selected panel. */
  children: ReactNode;
  className?: string;
}) {
  const base = useId();
  const tabs = useRef(new Map<T, HTMLButtonElement>());
  const tabId = (id: T) => `${base}-tab-${id}`;
  const panelId = (id: T) => `${base}-panel-${id}`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((item) => item.id === selected);
    const last = items.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index >= last ? 0 : index + 1) : event.key === 'ArrowLeft' ? (index <= 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    const target = items[next].id;
    onSelect(target);
    tabs.current.get(target)?.focus();
  }

  return (
    <div className={className}>
      <div className="tabs-line" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => {
          const active = item.id === selected;
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) tabs.current.set(item.id, node);
                else tabs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={tabId(item.id)}
              aria-selected={active}
              aria-controls={panelId(item.id)}
              tabIndex={active ? 0 : -1}
              data-testid={item.tabTestId}
              onClick={() => onSelect(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) =>
        item.id === selected ? (
          <div key={item.id} role="tabpanel" id={panelId(item.id)} aria-labelledby={tabId(item.id)} tabIndex={0} className="tab-panel" data-testid={item.panelTestId}>
            {children}
          </div>
        ) : (
          <div key={item.id} role="tabpanel" id={panelId(item.id)} aria-labelledby={tabId(item.id)} hidden />
        ),
      )}
    </div>
  );
}
