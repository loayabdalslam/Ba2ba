import { Page } from '@/components/Layout';

const Code = ({ children }: { children: string }) => (
  <pre className="bg-[#0d0d0d] text-gray-200 text-xs p-5 rounded-2xl overflow-x-auto whitespace-pre">{children}</pre>
);

export default function Docs() {
  return (
    <Page>
      <article className="max-w-3xl mx-auto px-6 py-16 space-y-10 text-sm leading-relaxed text-gray-700">
        <header>
          <h1 className="text-4xl font-light text-black">Run a Bee2Bee node</h1>
          <p className="mt-3">Serve an open model to the mesh from your own machine or server.</p>
        </header>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-black">1. Install</h2>
          <Code>{`pip install bee2bee            # Ollama or Hugging Face Inference API
pip install "bee2bee[hf,torch]" # local transformers models`}</Code>
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-black">2. Start serving</h2>
          <Code>{`# Ollama (pull the model first)
ollama pull llama3.2
bee2bee serve-ollama --model llama3.2 --region egypt --public-host node.example.com

# Local Hugging Face model
bee2bee serve-hf --model Qwen/Qwen2.5-0.5B-Instruct

# Hugging Face Inference API (token via environment, never on the command line)
export HF_TOKEN=hf_...
bee2bee serve-hf-remote --model HuggingFaceH4/zephyr-7b-beta`}</Code>
          <p>
            The node listens for peers on port <b>4003</b> (WebSocket) and serves a local HTTP API on <b>4002</b>. Open port
            4003 on your firewall or router, or put the node behind a TLS reverse proxy and announce it with
            <code> --public-host</code> and <code>BEE2BEE_TLS_*</code>.
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-black">3. Join the public mesh</h2>
          <Code>{`export BEE2BEE_REGISTRY_URL=https://coithub.org
export BEE2BEE_BOOTSTRAP=wss://mesh.coithub.org:4003`}</Code>
          <p>
            With a registry URL set, the node signs a registration with its Ed25519 key every 30 seconds. The gateway connects
            back to verify it before listing it. You can also paste the printed join link on the <a className="underline" href="/register">register page</a>.
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-black">Local HTTP API</h2>
          <p>Every endpoint except <code>/healthz</code>, <code>/readyz</code> and <code>/</code> requires the node API key:</p>
          <Code>{`bee2bee api-key            # prints the key (stored in ~/.bee2bee/api_key)
curl -H "Authorization: Bearer $KEY" localhost:4002/v1/chat/completions \\
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"hi"}]}'`}</Code>
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-black">Useful settings</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><code>BEE2BEE_MAX_CONCURRENT_GENERATIONS</code>: parallel requests your node accepts (default 4)</li>
            <li><code>BEE2BEE_ALLOWED_PEERS</code>: comma-separated peer ids for a private mesh</li>
            <li><code>BEE2BEE_REQUIRE_TLS=true</code>: refuse unencrypted peer connections</li>
            <li><code>BEE2BEE_LOG_JSON=true</code>: structured logs for log shippers</li>
          </ul>
          <p>See the repository README for the full list.</p>
        </section>
      </article>
    </Page>
  );
}
