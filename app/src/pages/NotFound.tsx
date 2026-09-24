import { Page } from '@/components/Layout';
import { Link } from '@/lib/router';

export default function NotFound() {
  return (
    <Page>
      <div className="py-32 text-center space-y-4">
        <h1 className="text-5xl font-light">404</h1>
        <p className="text-gray-500">This page does not exist.</p>
        <Link to="/" className="underline text-sm">Back home</Link>
      </div>
    </Page>
  );
}
