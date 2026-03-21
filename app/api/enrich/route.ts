import { NextResponse } from 'next/server';
import { createHash } from 'crypto';

export async function POST(request: Request) {
  try {
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

    const enrichedData: Record<string, any> = {};

    // 1. Try Gravatar Profile API
    const gravatarHash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
    
    try {
      const gravatarRes = await fetch(`https://gravatar.com/${gravatarHash}.json`);
      
      if (gravatarRes.ok) {
        const gravatarData = await gravatarRes.json();
        const profile = gravatarData.entry?.[0];

        if (profile) {
          // Extract name
          if (profile.displayName && !enrichedData.name) {
            enrichedData.name = profile.displayName;
          } else if (profile.name?.formatted) {
            enrichedData.name = profile.name.formatted;
          } else if (profile.name?.givenName && profile.name?.familyName) {
            enrichedData.name = `${profile.name.givenName} ${profile.name.familyName}`;
          }

          // Extract location
          if (profile.currentLocation) {
            enrichedData.location = profile.currentLocation;
          }

          // Extract bio/about
          if (profile.aboutMe) {
            enrichedData.bio = profile.aboutMe;
          }

          // Extract social profiles
          const socialLinks: Record<string, string> = {};
          if (profile.urls && Array.isArray(profile.urls)) {
            profile.urls.forEach((url: any) => {
              const value = url.value || url.url;
              if (value) {
                if (value.includes('linkedin.com')) {
                  socialLinks.linkedin = value;
                } else if (value.includes('twitter.com') || value.includes('x.com')) {
                  socialLinks.twitter = value;
                } else if (value.includes('github.com')) {
                  socialLinks.github = value;
                }
              }
            });
          }

          if (Object.keys(socialLinks).length > 0) {
            enrichedData.social = socialLinks;
          }

          // Extract phone numbers
          if (profile.phoneNumbers && Array.isArray(profile.phoneNumbers)) {
            const phone = profile.phoneNumbers[0]?.value;
            if (phone) {
              enrichedData.phone = phone;
            }
          }

          enrichedData.source = 'gravatar';
        }
      }
    } catch (error) {
      console.log('Gravatar fetch failed (not found or network error)');
    }

    // 2. Parse email domain for company info
    const domain = email.split('@')[1];
    if (domain && domain !== 'gmail.com' && domain !== 'outlook.com' && 
        domain !== 'yahoo.com' && domain !== 'hotmail.com' && 
        domain !== 'icloud.com' && domain !== 'protonmail.com') {
      
      // Extract company name from domain
      const companyName = domain
        .split('.')[0]
        .split('-').map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      
      enrichedData.company = companyName;
      enrichedData.companyDomain = domain;
      
      // Clearbit logo URL
      enrichedData.companyLogo = `https://logo.clearbit.com/${domain}`;
    }

    // 3. Generate suggested notes from enrichment
    const notes: string[] = [];
    if (enrichedData.bio) {
      notes.push(enrichedData.bio);
    }
    if (enrichedData.location) {
      notes.push(`Location: ${enrichedData.location}`);
    }
    if (enrichedData.company) {
      notes.push(`Company: ${enrichedData.company}`);
    }
    if (enrichedData.social?.linkedin) {
      notes.push(`LinkedIn: ${enrichedData.social.linkedin}`);
    }

    if (notes.length > 0) {
      enrichedData.suggestedNotes = notes.join('\n');
    }

    return NextResponse.json({ 
      success: true,
      data: enrichedData,
      found: Object.keys(enrichedData).length > 0
    });
  } catch (error) {
    console.error('Enrichment failed:', error);
    return NextResponse.json({ error: 'Enrichment failed' }, { status: 500 });
  }
}
