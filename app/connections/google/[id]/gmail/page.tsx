import { GoogleGmailMailbox } from '@/components/google-gmail-mailbox';
export default async function GmailMailboxPage({ params }: { params: Promise<{ id: string }> }) { return <GoogleGmailMailbox connectionId={(await params).id} />; }
