'use client';

import { useEffect, useRef, useState } from 'react';

type TagInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
};

export function TagInput({ value, onChange, placeholder, className = '', id }: TagInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    fetch('/api/contacts?view=tags&pageSize=100')
      .then((res) => res.json())
      .then((data) => {
        const tags = Array.isArray(data.tags)
          ? data.tags.flatMap((entry: unknown) => (
              entry
              && typeof entry === 'object'
              && 'tag' in entry
              && typeof entry.tag === 'string'
                ? [entry.tag]
                : []
            ))
          : [];
        const uniqueTags = new Map<string, string>();
        for (const tag of tags) {
          const normalized = tag.trim();
          if (normalized && !uniqueTags.has(normalized.toLowerCase())) {
            uniqueTags.set(normalized.toLowerCase(), normalized);
          }
        }
        setAllTags(Array.from(uniqueTags.values()).sort((left, right) => left.localeCompare(right)));
      })
      .catch(() => {});
  }, []);

  // Get the current tag being typed (the part after the last comma)
  function getCurrentTag(): string {
    const parts = value.split(',');
    return (parts[parts.length - 1] || '').trim();
  }

  // Get tags already entered
  function getEnteredTags(): Set<string> {
    return new Set(
      value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    );
  }

  const currentTag = getCurrentTag();
  const enteredTags = getEnteredTags();
  const filtered = currentTag
    ? allTags
        .filter(t => t.includes(currentTag.toLowerCase()) && !enteredTags.has(t))
        .slice(0, 8)
    : [];

  function insertTag(tag: string) {
    const parts = value.split(',').map(t => t.trim()).filter(Boolean);
    // Replace the last (partial) tag with the selected one
    parts[parts.length - 1] = tag;
    onChange(parts.join(', ') + ', ');
    setShowDropdown(false);

    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange(e.target.value);
    const current = e.target.value.split(',').pop()?.trim() || '';
    if (current.length > 0) {
      setShowDropdown(true);
      setSelectedIndex(0);
    } else {
      setShowDropdown(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown || filtered.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Tab' && filtered.length > 0) {
      e.preventDefault();
      insertTag(filtered[selectedIndex]);
    }
  }

  function handleBlur() {
    setTimeout(() => setShowDropdown(false), 200);
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        maxLength={10_200}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={() => {
          const current = getCurrentTag();
          if (current.length > 0) setShowDropdown(true);
        }}
        placeholder={placeholder}
        className={`flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50 transition-all ${className}`}
      />
      {showDropdown && filtered.length > 0 && (
        <div className="absolute left-0 right-0 z-50 mt-1 bg-white rounded-xl border border-border shadow-lg overflow-hidden max-h-40 overflow-y-auto">
          {filtered.map((tag, index) => (
            <button
              key={tag}
              type="button"
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors ${
                index === selectedIndex ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertTag(tag);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="w-2 h-2 rounded-full bg-muted-foreground/30" />
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
