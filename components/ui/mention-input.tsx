'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Contact } from '@/lib/db';
import { Avatar } from '@/components/ui/avatar';

type MentionInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  id?: string;
};

type ContactOption = Pick<Contact, 'id' | 'name' | 'email' | 'photo_url'>;

export function MentionInput({ value, onChange, placeholder, rows = 3, className = '', id }: MentionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [query, setQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!showDropdown) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams({
        view: 'mentions',
        search: query,
        limit: '6',
      });
      fetch(`/api/contacts?${params}`, { signal: controller.signal, cache: 'no-store' })
        .then((res) => res.ok ? res.json() : { contacts: [] })
        .then((data) => setContacts(Array.isArray(data.contacts) ? data.contacts : []))
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setContacts([]);
        });
    }, 150);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, showDropdown]);

  const filtered = contacts;

  const insertMention = useCallback((contact: ContactOption) => {
    const before = value.slice(0, mentionStart);
    const after = value.slice(textareaRef.current?.selectionStart ?? value.length);
    const mention = `@[${contact.name}](id:${contact.id})`;
    const newValue = before + mention + after;
    onChange(newValue);
    setShowDropdown(false);
    setQuery('');
    setMentionStart(-1);

    // Restore cursor position after React re-renders
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        const cursorPos = before.length + mention.length;
        textarea.selectionStart = cursorPos;
        textarea.selectionEnd = cursorPos;
        textarea.focus();
      }
    });
  }, [value, mentionStart, onChange]);

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newValue = e.target.value;
    onChange(newValue);

    const cursorPos = e.target.selectionStart;
    const textBefore = newValue.slice(0, cursorPos);

    // Find the last @ that could be a mention trigger
    const lastAt = textBefore.lastIndexOf('@');

    if (lastAt >= 0) {
      // Only trigger if @ is at start or preceded by whitespace
      const charBefore = lastAt > 0 ? textBefore[lastAt - 1] : ' ';
      if (charBefore === ' ' || charBefore === '\n' || lastAt === 0) {
        const searchText = textBefore.slice(lastAt + 1);
        // Only show dropdown if no space gap > reasonable name length
        if (searchText.length <= 40 && !searchText.includes('\n')) {
          setMentionStart(lastAt);
          setQuery(searchText);
          setShowDropdown(true);
          setSelectedIndex(0);
          return;
        }
      }
    }

    setShowDropdown(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!showDropdown || filtered.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertMention(filtered[selectedIndex]);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  }

  function handleBlur() {
    // Delay to allow click on dropdown items
    setTimeout(() => setShowDropdown(false), 200);
  }

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={rows}
        className={`flex w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50 transition-all resize-none ${className}`}
      />
      {showDropdown && filtered.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute left-0 right-0 z-50 mt-1 bg-white rounded-xl border border-border shadow-lg overflow-hidden max-h-48 overflow-y-auto"
        >
          {filtered.map((contact, index) => (
              <button
                key={contact.id}
                type="button"
                className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${
                  index === selectedIndex ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(contact);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <Avatar contact={contact} size="sm" className="!w-6 !h-6 !rounded-full !shadow-none" />
                <span className="truncate font-medium">{contact.name}</span>
                {contact.email && (
                  <span className="text-xs text-muted-foreground truncate ml-auto">{contact.email}</span>
                )}
              </button>
          ))}
        </div>
      )}
    </div>
  );
}
