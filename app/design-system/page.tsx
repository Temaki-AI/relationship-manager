import { Heart, Plus } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Disclosure } from '@/components/ui/disclosure';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { colors, radii, spacing } from '@/packages/design/src/tokens';

const swatches = [
  ['Canvas', colors.canvas], ['Surface', colors.surface], ['Warm surface', colors.surfaceWarm],
  ['Ink', colors.ink], ['Muted ink', colors.muted], ['Rose action', colors.primary],
  ['Soft rose', colors.primarySoft], ['Sage', colors.mossSoft], ['Peach', colors.peach],
  ['Success', colors.moss], ['Warning', colors.amber], ['Error', colors.danger],
];

export default function DesignSystemPage() {
  return <div className="mx-auto max-w-5xl space-y-8 py-6">
    <header className="space-y-3">
      <div className="flex items-center gap-2 text-primary"><Heart aria-hidden="true" className="h-6 w-6 fill-current" /><span className="text-sm font-semibold uppercase tracking-[0.15em]">Everclose</span></div>
      <h1 className="text-3xl font-bold">Modern + Warm</h1>
      <p className="max-w-2xl text-muted-foreground">A calm home for your relationships. Ivory surfaces, clear sans-serif type, deep rose actions, and a little warmth from pastel avatars.</p>
      <p className="text-sm text-muted-foreground">Component reference · Example content is illustrative.</p>
    </header>
    <Card><CardHeader><CardTitle>Colors</CardTitle></CardHeader><CardContent>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{swatches.map(([name, color]) => <div key={name} className="space-y-2">
        <div aria-hidden="true" className="h-16 rounded-lg border border-border" style={{ backgroundColor: color }} />
        <p className="text-sm font-medium">{name}</p><p className="text-xs text-muted-foreground">{color}</p>
      </div>)}</div>
    </CardContent></Card>
    <div className="grid gap-6 md:grid-cols-2">
      <Card><CardHeader><CardTitle>Typography</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-3xl font-bold tracking-tight">Today</p><p className="text-xl font-semibold">Next up</p>
        <p className="text-base">A small hello can mean a lot.</p><p className="text-sm font-semibold">Reach out</p>
        <p className="text-[13px] leading-5 text-muted-foreground">Last conversation · Yesterday</p>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Spacing & shape</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">A 4 px rhythm. Cards have 20 px corners; controls have 12 px corners. Touch targets start at 44 px, with 48 px preferred.</p>
        <div className="flex flex-wrap items-end gap-3">{[spacing.xs, spacing.sm, spacing.md, spacing.lg, spacing.xl, spacing.xxl, spacing.section].map(value => <div key={value} className="space-y-1 text-center"><div className="mx-auto bg-secondary" style={{ width: value, height: value, borderRadius: 4 }} /><span className="text-xs text-muted-foreground">{value}</span></div>)}</div>
        <div className="flex gap-3">{[radii.control, radii.card, radii.dialog].map(radius => <div key={radius} className="flex h-16 w-16 items-center justify-center border border-input bg-muted text-sm" style={{ borderRadius: radius }}>{radius}</div>)}</div>
      </CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle>Actions</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap gap-3"><Button><Plus aria-hidden="true" className="h-4 w-4" />Add someone</Button><Button variant="secondary">Log a moment</Button><Button variant="outline">Review</Button><Button variant="ghost">Later</Button><Button variant="destructive">Delete</Button><Button disabled>Saving…</Button></div>
      <p className="text-sm text-muted-foreground">One primary action per task. Secondary actions use soft rose. Destructive actions use error red and a confirmation with recovery guidance.</p>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Fields & validation</CardTitle></CardHeader><CardContent className="grid gap-5 md:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="reference-name">Name</Label><Input id="reference-name" placeholder="Someone you care about" /><p className="text-[13px] text-muted-foreground">Labels stay visible while typing.</p></div>
      <div className="space-y-2"><Label htmlFor="reference-email">Email</Label><Input id="reference-email" type="email" defaultValue="example" aria-invalid="true" aria-describedby="reference-email-error" /><p id="reference-email-error" className="text-[13px] text-destructive">Enter a complete email address.</p></div>
      <div className="space-y-2"><Label htmlFor="reference-note">A detail to remember</Label><Textarea id="reference-note" placeholder="What made your last conversation special?" /></div>
      <div className="space-y-2"><Label htmlFor="reference-disabled">Unavailable field</Label><Input id="reference-disabled" value="Connect an account first" disabled readOnly /></div>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>People & feedback</CardTitle></CardHeader><CardContent className="space-y-5">
      <div className="flex flex-wrap gap-5">{['Ana Silva', 'Alex Chen', 'Maya Patel', 'Sam Rivera', 'Robin Lee'].map(name => <div key={name} className="flex items-center gap-3"><Avatar contact={{ name }} /><span className="text-sm font-medium">{name}</span></div>)}</div>
      <div className="flex flex-wrap gap-2"><Badge>Reminder</Badge><Badge variant="secondary">Personal</Badge><Badge variant="success">Saved</Badge><Badge variant="warning">Needs review</Badge><Badge variant="destructive">Could not save</Badge><Badge variant="info">Offline copy</Badge></div>
      <div className="rounded-lg bg-success-soft p-4 text-sm text-success">Your note is saved. Status includes text, not color alone.</div>
      <div className="rounded-lg bg-warning-soft p-4 text-sm text-warning">You’re offline. Saved relationships are still available.</div>
      <div className="rounded-lg bg-danger-soft p-4 text-sm text-destructive">Could not save this change. Your previous note is still here.</div>
    </CardContent></Card>
    <Disclosure title="A little more detail"><p className="text-sm text-muted-foreground">Optional detail stays one tap away. Main tasks remain visible; expansion and focus use native browser behavior.</p></Disclosure>
    <footer className="pb-6 text-sm text-muted-foreground">Today · People · Calendar · Settings. The same four destinations on web and iPhone.</footer>
  </div>;
}
