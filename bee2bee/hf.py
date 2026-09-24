"""Hugging Face transformers helpers (optional dependency)."""

from __future__ import annotations

import threading
from typing import Any, Callable, Optional, Tuple

from loguru import logger

from .protocol import GenerationRequest


def has_transformers() -> bool:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401

        return True
    except Exception:
        return False


def load_model_and_tokenizer(model_name: str, device: Optional[str] = None):
    import torch  # type: ignore
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_name)
    mdl = AutoModelForCausalLM.from_pretrained(model_name)
    if device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    mdl = mdl.to(device)
    mdl.eval()
    return mdl, tok, device


def _build_inputs(tokenizer, device: str, req: GenerationRequest):
    if req.messages is not None and getattr(tokenizer, "chat_template", None):
        try:
            text = tokenizer.apply_chat_template(req.messages, tokenize=False, add_generation_prompt=True)
            return tokenizer(text, return_tensors="pt").to(device)
        except Exception as e:  # pragma: no cover - depends on the model
            logger.warning(f"Chat template failed, falling back to plain prompt: {e}")
    return tokenizer(req.prompt_text(), return_tensors="pt").to(device)


def start_generation_thread(
    model,
    tokenizer,
    device: str,
    req: GenerationRequest,
    stop: threading.Event,
    on_text: Callable[[Any], None],
    sentinel: object,
) -> Tuple[int, threading.Thread]:
    """Run ``model.generate`` in a thread, streaming decoded text to ``on_text``.

    ``on_text`` receives text chunks, then an exception (if generation failed),
    then ``sentinel``. Setting ``stop`` aborts generation at the next token.
    """
    import torch  # type: ignore
    from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer

    class _StopOnEvent(StoppingCriteria):
        def __call__(self, input_ids, scores, **kwargs) -> bool:  # type: ignore[override]
            return stop.is_set()

    inputs = _build_inputs(tokenizer, device, req)
    prompt_tokens = int(inputs["input_ids"].shape[-1])
    streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=300)
    pad = tokenizer.eos_token_id if tokenizer.pad_token_id is None else tokenizer.pad_token_id
    gen_kwargs = {
        **inputs,
        "max_new_tokens": req.max_new_tokens,
        "streamer": streamer,
        "pad_token_id": pad,
        "stopping_criteria": StoppingCriteriaList([_StopOnEvent()]),
    }
    if req.temperature > 0:
        gen_kwargs.update(do_sample=True, temperature=req.temperature, top_p=0.95)
    else:
        gen_kwargs["do_sample"] = False

    errors: list = []

    def _generate() -> None:
        try:
            with torch.no_grad():
                model.generate(**gen_kwargs)
        except Exception as e:
            errors.append(e)
            streamer.end()  # unblock the consumer loop below

    def _run() -> None:
        gen = threading.Thread(target=_generate, daemon=True)
        gen.start()
        try:
            for text in streamer:
                if stop.is_set():
                    break
                if text:
                    on_text(text)
        except Exception as e:
            errors.append(e)
        finally:
            gen.join()
            if errors:
                on_text(errors[0])
            on_text(sentinel)

    worker = threading.Thread(target=_run, daemon=True)
    worker.start()
    return prompt_tokens, worker
