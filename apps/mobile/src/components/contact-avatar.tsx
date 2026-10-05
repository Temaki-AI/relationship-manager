import { Avatar } from './design-system';
import { useContactPhoto } from '@/native/contact-photo';

/** Lists use already cached photos; opening a profile downloads its current photo. */
export function ContactAvatar({ id, name, size }: { id: string; name: string; size?: number }) {
  const photo = useContactPhoto(id);
  return <Avatar name={name} size={size} photo={photo.uri} />;
}
