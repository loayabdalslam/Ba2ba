import { ArrowRight, Cpu, Globe, Shield, Terminal, Zap } from 'lucide-react';

import { AnimatedTerminal } from '@/components/AnimatedTerminal';
import { Page } from '@/components/Layout';
import { NeuralMap } from '@/components/NeuralMap';
import { useMeshStatus } from '@/hooks/useMeshStatus';
import { fmtNumber } from '@/lib/format';
import { Link } from '@/lib/router';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="text-3xl md:text-4xl font-light tracking-tight">{value}</p>
      <p className="label mt-2">{label}</p>
    </div>
  );
}

export default function Landing() {
  const { status, metrics, loading } = useMeshStatus(30000);
  const regions = Object.keys(status.mesh);

  return (
    <Page>
      <section className="relative overflow-hidden px-6 pt-24 pb-20">
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8">
            <h1 className="google-sans-title">Open models,<br />served by people.</h1>
            <p className="sub-title">
              Bee2Bee is a peer-to-peer network where anyone can serve an open model from their own GPU, and anyone can use it
              through a single chat or an OpenAI-compatible API.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link to="/chat" className="pill-btn bg-black text-white hover:scale-105 active:scale-95 gap-2">
                Start chatting <ArrowRight className="w-4 h-4" />
              </Link>
              <Link to="/docs" className="pill-btn bg-white text-black border border-gray-200 hover:bg-gray-50">
                Run a node
              </Link>
            </div>
          </div>
          <div className="flex justify-center">
            <NeuralMap regions={regions} />
          </div>
        </div>
        <div className="absolute top-0 right-0 w-[700px] h-[700px] bg-blue-50 rounded-full blur-[140px] -z-10" />
      </section>

      <section className="px-6 pb-20" aria-label="Live network statistics">
        <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8 card">
          <Stat label="Nodes online" value={loading ? '…' : fmtNumber(status.connectedNodes)} />
          <Stat label="Models" value={loading ? '…' : fmtNumber(status.models.length)} />
          <Stat label="Regions" value={loading ? '…' : fmtNumber(regions.length)} />
          <Stat label="Tokens served" value={metrics ? fmtNumber(metrics.tokens) : '—'} />
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-8">
          <div className="card">
            <Globe className="w-7 h-7 mb-5" aria-hidden />
            <h2 className="text-xl font-light mb-3">Decentralized routing</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              Requests go to the best available node for your model, ranked by reliability and latency, with automatic
              failover if a node drops.
            </p>
          </div>
          <div className="card">
            <Shield className="w-7 h-7 mb-5" aria-hidden />
            <h2 className="text-xl font-light mb-3">Verified nodes</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              Every node has an Ed25519 identity and proves it on each connection, so nobody can impersonate a node or
              hijack its registration.
            </p>
          </div>
          <div className="card">
            <Zap className="w-7 h-7 mb-5" aria-hidden />
            <h2 className="text-xl font-light mb-3">OpenAI-compatible API</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              Create an API key in your account and point any OpenAI SDK at <code className="text-xs">/v1</code>. Usage and
              monthly quotas are tracked per key.
            </p>
          </div>
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="max-w-6xl mx-auto bg-[#0a0a0c] rounded-[40px] p-8 md:p-12 grid xl:grid-cols-3 gap-10 items-center">
          <div className="space-y-6 text-white">
            <Terminal className="w-8 h-8" aria-hidden />
            <h2 className="text-3xl font-light">Contribute your GPU</h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              Install the Python package, point it at Ollama or a Hugging Face model, and your node joins the mesh.
            </p>
            <Link to="/docs" className="inline-flex items-center gap-2 text-sm font-semibold underline">
              Node setup guide <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          <div className="xl:col-span-2">
            <AnimatedTerminal />
          </div>
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="max-w-3xl mx-auto card">
          <Cpu className="w-7 h-7 mb-5" aria-hidden />
          <h2 className="text-xl font-light mb-3">What happens to my prompts?</h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            Your prompt is sent through our gateway to a community node, which runs the model and streams the answer back.
            That node's operator can technically see the prompt, so do not send passwords, personal or confidential data.
            The gateway does not store chat content. If you sign in, you can choose to save your history to your own account.
            Read the full <Link to="/privacy" className="underline">privacy policy</Link>.
          </p>
        </div>
      </section>
    </Page>
  );
}
