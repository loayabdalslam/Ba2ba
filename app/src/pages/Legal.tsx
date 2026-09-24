import { Page } from '@/components/Layout';

const Updated = () => <p className="text-xs text-gray-400">Last updated: September 2026 · Draft pending legal review</p>;

export function Privacy() {
  return (
    <Page>
      <article className="max-w-3xl mx-auto px-6 py-16 space-y-6 text-sm leading-relaxed text-gray-700">
        <h1 className="text-4xl font-light text-black">Privacy policy</h1>
        <Updated />
        <h2 className="text-lg font-semibold text-black">How requests are processed</h2>
        <p>
          When you send a message, it travels over HTTPS to the CoitHub gateway and is forwarded to a node in the Bee2Bee
          network. Nodes are run by independent volunteers. The node that answers receives your prompt and conversation
          context in order to run the model. We cannot guarantee how node operators handle that data. <b>Do not send
          passwords, personal, health, financial or confidential information.</b>
        </p>
        <h2 className="text-lg font-semibold text-black">What we store</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Anonymous use: no chat content is stored by the gateway. We keep aggregate counters (number of requests and tokens) and short-lived technical logs (IP address, request id, status) for security and abuse prevention.</li>
          <li>Signed-in use: your email address, your API keys (only a hash of each secret), token usage per key, and, if you enable it, your chat history. History is visible only to you and can be deleted at any time from the chat sidebar.</li>
          <li>Node operators: the node's public key, network address, region, models and self-reported performance metrics.</li>
        </ul>
        <h2 className="text-lg font-semibold text-black">Analytics</h2>
        <p>If enabled on this deployment, Microsoft Clarity is loaded only after you accept it in the consent banner.</p>
        <h2 className="text-lg font-semibold text-black">Processors</h2>
        <p>Accounts and data are hosted with Supabase. The gateway and website are hosted with our infrastructure providers.</p>
        <h2 className="text-lg font-semibold text-black">Your rights</h2>
        <p>You can request a copy or deletion of your account data by contacting the maintainers through the project's GitHub repository.</p>
      </article>
    </Page>
  );
}

export function Terms() {
  return (
    <Page>
      <article className="max-w-3xl mx-auto px-6 py-16 space-y-6 text-sm leading-relaxed text-gray-700">
        <h1 className="text-4xl font-light text-black">Terms of use</h1>
        <Updated />
        <p>CoitHub and Bee2Bee are provided "as is", without warranties of any kind. Model output can be inaccurate or offensive; verify important information independently.</p>
        <p>You agree not to use the service to break the law, to harass others, to generate malware or abuse material, or to overload the network (for example by bypassing rate limits).</p>
        <p>Node operators are responsible for the models they serve and for complying with those models' licenses. Nodes that misbehave may be removed from the registry.</p>
        <p>API access is subject to the quota shown in your account. We may suspend keys that are abused.</p>
        <p>The software is open source under the MIT license.</p>
      </article>
    </Page>
  );
}
