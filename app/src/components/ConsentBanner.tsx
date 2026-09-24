import { useState } from 'react';

import { analyticsConfigured, getConsent, setConsent } from '@/lib/consent';
import { Link } from '@/lib/router';

export function ConsentBanner() {
  const [open, setOpen] = useState(() => analyticsConfigured && getConsent() === null);
  if (!open) return null;
  const choose = (v: 'granted' | 'denied') => {
    setConsent(v);
    setOpen(false);
  };
  return (
    <div role="dialog" aria-label="Analytics consent" className="fixed bottom-4 inset-x-4 md:left-auto md:w-[420px] z-50 card p-6 text-sm">
      <p className="text-gray-600 leading-relaxed">
        We would like to use Microsoft Clarity to understand how the site is used. It is only loaded if you agree.{' '}
        <Link to="/privacy" className="underline">Privacy policy</Link>
      </p>
      <div className="flex gap-3 mt-4">
        <button className="flex-1 h-10 rounded-full bg-black text-white text-xs font-bold" onClick={() => choose('granted')}>Allow</button>
        <button className="flex-1 h-10 rounded-full bg-gray-100 text-xs font-bold" onClick={() => choose('denied')}>Decline</button>
      </div>
    </div>
  );
}
