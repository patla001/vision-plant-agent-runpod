"""Shared agentic loop used by all three agents."""
from __future__ import annotations

import json
from typing import Any

import anthropic

from _logging import log as _log


def run_agent_loop(
    client: anthropic.Anthropic,
    agent_name: str,
    system_prompt: str,
    tools: list[dict],
    initial_message: str,
    tool_executor: callable,
    model: str = "claude-opus-4-7",
    max_iterations: int = 30,
) -> str:
    """
    Standard agentic loop with prompt caching.
    Runs until stop_reason == 'end_turn' or max_iterations is reached.
    Returns the final text response.

    Adaptive thinking is enabled only for Opus 4.x and Sonnet 4.6 models.
    Haiku models reject `thinking` with HTTP 400 ("adaptive thinking is not
    supported on this model"), so we omit the parameter entirely for them.
    """
    # Detect models that support adaptive thinking. As of 2026-04, this is
    # Opus 4.6, Opus 4.7, and Sonnet 4.6. Haiku 4.5 does NOT support it.
    supports_adaptive = (
        model.startswith("claude-opus-4-")
        or model.startswith("claude-sonnet-4-6")
    )
    extra_kwargs: dict = {}
    if supports_adaptive:
        extra_kwargs["thinking"] = {"type": "adaptive"}

    messages: list[dict] = [{"role": "user", "content": initial_message}]

    for iteration in range(max_iterations):
        _log(agent_name, f"Iteration {iteration + 1}/{max_iterations}")

        response = client.messages.create(
            model=model,
            max_tokens=16000,
            system=[
                {
                    "type": "text",
                    "text": system_prompt,
                    # Cache the system prompt — it's large and stable across turns
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            tools=tools,
            messages=messages,
            **extra_kwargs,
        )

        # Append full assistant response (includes tool_use blocks if any)
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            final_text = next(
                (b.text for b in response.content if b.type == "text"), ""
            )
            _log(agent_name, "Done.")
            return final_text

        if response.stop_reason == "tool_use":
            tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
            tool_results: list[dict] = []

            for block in tool_use_blocks:
                _log(agent_name, f"Calling tool: {block.name}({json.dumps(block.input)[:120]})")
                try:
                    result = tool_executor(block.name, block.input)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(result),
                    })
                except Exception as exc:
                    import traceback
                    tb = traceback.format_exc()
                    _log(agent_name, f"ERROR in tool '{block.name}': {type(exc).__name__}: {exc}")
                    print(tb, flush=True)   # full stack to log file for dashboard
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"Error ({type(exc).__name__}): {exc}\n\n{tb}",
                        "is_error": True,
                    })

            messages.append({"role": "user", "content": tool_results})
            continue

        # Unexpected stop reason
        _log(agent_name, f"Unexpected stop_reason: {response.stop_reason}")
        break

    return "[Agent loop reached max iterations]"
