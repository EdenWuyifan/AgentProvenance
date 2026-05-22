"use client";

import * as d3 from "d3";

const TOOL_CALL_KEYS = ["tool_calls", "toolCalls", "calls", "steps"];
const GLYPH_TYPES = [
  "circle",
  "cross",
  "diamond",
  "square",
  "triangle",
  "star",
  "wye",
  "plus",
  "times",
];
const GROUP_COLORS = d3.schemeTableau10;
const UNKNOWN_GROUP_COLOR = "#52525b";

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function prepareTracings(tracings = []) {
  return tracings.map((tracing, index) => ({
    ...tracing,
    id: tracing?.id ?? tracing?.trace_id ?? index,
  }));
}

export function parseTracingPayload(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return parseJsonLines(trimmed);
  }
}

export function getTracingScore(tracing, scoreKey = "score") {
  const rawScore = tracing?.[scoreKey];
  if (typeof rawScore === "boolean") {
    return rawScore ? 1 : 0;
  }

  if (rawScore === null || rawScore === undefined || rawScore === "") {
    return 0;
  }

  const numericScore = Number(rawScore);
  return Number.isFinite(numericScore) ? numericScore : 0;
}

function normalizeToolName(call) {
  if (typeof call === "string") {
    return call;
  }

  if (!call || typeof call !== "object") {
    return "";
  }

  const directName =
    call.name ??
    call.tool ??
    call.tool_name ??
    call.toolName ??
    call.function ??
    call.type;

  if (typeof directName === "string") {
    return directName;
  }

  if (typeof call.function === "object" && typeof call.function?.name === "string") {
    return call.function.name;
  }

  return "";
}

function normalizeToolArgs(call) {
  if (!call || typeof call !== "object") {
    return null;
  }

  if ("args" in call) {
    return call.args;
  }

  if ("arguments" in call) {
    return call.arguments;
  }

  if ("input" in call) {
    return call.input;
  }

  return null;
}

function normalizeToolCall(call, fallbackId) {
  const name = normalizeToolName(call);
  if (!name) {
    return null;
  }

  if (typeof call === "string") {
    return {
      id: fallbackId,
      name,
      type: "tool_call",
      args: null,
      response: null,
      status: null,
    };
  }

  return {
    id: call.id ?? call.tool_call_id ?? fallbackId,
    name,
    type: call.type ?? "tool_call",
    args: normalizeToolArgs(call),
    response: call.response ?? null,
    status: typeof call.status === "string" ? call.status : null,
  };
}

export function extractToolCallRecords(tracing) {
  const tracePrefix = tracing?.id ?? tracing?.trace_id ?? "trace";
  for (const key of TOOL_CALL_KEYS) {
    const toolCalls = tracing?.[key];
    if (!Array.isArray(toolCalls)) {
      continue;
    }

    return toolCalls.flatMap((call, callIndex) => {
      const record = normalizeToolCall(call, `${tracePrefix}-${key}-${callIndex}`);
      if (!record) {
        return [];
      }

      return [{
        ...record,
        index: callIndex,
      }];
    });
  }

  return [];
}

export function createGlyphSystem(toolSets = {}) {
  const toolToGroup = new Map();
  const groupNames = Object.keys(toolSets).sort();

  groupNames.forEach((groupName) => {
    const tools = toolSets[groupName] || [];
    tools.forEach((toolName) => {
      toolToGroup.set(toolName, groupName);
    });
  });

  const groupToGlyph = new Map();
  const groupToColor = new Map();
  groupNames.forEach((groupName, index) => {
    groupToGlyph.set(groupName, GLYPH_TYPES[index % GLYPH_TYPES.length]);
    groupToColor.set(groupName, GROUP_COLORS[index % GROUP_COLORS.length]);
  });

  const getGroup = (toolName) => toolToGroup.get(toolName) || "unknown";

  return {
    getGlyph: (toolName) => {
      const group = toolToGroup.get(toolName);
      return group ? groupToGlyph.get(group) || "circle" : "circle";
    },
    getGroup,
    getColor: (toolName) => groupToColor.get(getGroup(toolName)) || UNKNOWN_GROUP_COLOR,
    getGroupColor: (groupName) => groupToColor.get(groupName) || UNKNOWN_GROUP_COLOR,
    getAllGroups: () => Array.from(groupToGlyph.keys()),
    getGroupGlyph: (groupName) => groupToGlyph.get(groupName) || "circle",
  };
}

export function renderGlyph(container, glyphType, x, y, fill = "#111827", size = 5) {
  const symbolSize = size * 8;

  switch (glyphType) {
    case "circle":
      return container
        .append("circle")
        .attr("cx", x)
        .attr("cy", y)
        .attr("r", size)
        .attr("fill", fill)
        .style("cursor", "pointer");

    case "cross":
      return container
        .append("path")
        .attr("d", d3.symbol().type(d3.symbolCross).size(symbolSize))
        .attr("transform", `translate(${x},${y})`)
        .attr("fill", fill)
        .style("cursor", "pointer");

    case "diamond":
      return container
        .append("path")
        .attr("d", d3.symbol().type(d3.symbolDiamond).size(symbolSize))
        .attr("transform", `translate(${x},${y})`)
        .attr("fill", fill)
        .style("cursor", "pointer");

    case "square":
      return container
        .append("rect")
        .attr("x", x - size)
        .attr("y", y - size)
        .attr("width", size * 2)
        .attr("height", size * 2)
        .attr("fill", fill)
        .style("cursor", "pointer");

    case "triangle":
      return container
        .append("path")
        .attr("d", d3.symbol().type(d3.symbolTriangle).size(symbolSize))
        .attr("transform", `translate(${x},${y})`)
        .attr("fill", fill)
        .style("cursor", "pointer");

    case "star":
      return container
        .append("path")
        .attr("d", d3.symbol().type(d3.symbolStar).size(symbolSize))
        .attr("transform", `translate(${x},${y})`)
        .attr("fill", fill)
        .style("cursor", "pointer");

    case "wye":
      return container
        .append("path")
        .attr("d", d3.symbol().type(d3.symbolWye).size(symbolSize))
        .attr("transform", `translate(${x},${y})`)
        .attr("fill", fill)
        .style("cursor", "pointer");

    case "plus": {
      const plusGroup = container
        .append("g")
        .attr("transform", `translate(${x},${y})`)
        .style("cursor", "pointer");
      plusGroup
        .append("rect")
        .attr("x", -size)
        .attr("y", -1)
        .attr("width", size * 2)
        .attr("height", 2)
        .attr("fill", fill)
        .style("pointer-events", "none");
      plusGroup
        .append("rect")
        .attr("x", -1)
        .attr("y", -size)
        .attr("width", 2)
        .attr("height", size * 2)
        .attr("fill", fill)
        .style("pointer-events", "none");
      return plusGroup;
    }

    case "times": {
      const timesGroup = container
        .append("g")
        .attr("transform", `translate(${x},${y}) rotate(45)`)
        .style("cursor", "pointer");
      timesGroup
        .append("rect")
        .attr("x", -size)
        .attr("y", -1)
        .attr("width", size * 2)
        .attr("height", 2)
        .attr("fill", fill)
        .style("pointer-events", "none");
      timesGroup
        .append("rect")
        .attr("x", -1)
        .attr("y", -size)
        .attr("width", 2)
        .attr("height", size * 2)
        .attr("fill", fill)
        .style("pointer-events", "none");
      return timesGroup;
    }

    default:
      return container
        .append("circle")
        .attr("cx", x)
        .attr("cy", y)
        .attr("r", size)
        .attr("fill", fill)
        .style("cursor", "pointer");
  }
}
