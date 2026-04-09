"use client";

import * as d3 from "d3";
import {
    createGlyphSystem,
    extractToolCallRecords,
    getTracingScore,
    prepareTracings,
    renderGlyph,
} from "./visualization_shared";

function buildToolCoverageData(tools, tracingToolCalls) {
    return tools.map((tool) => {
        let usageCount = 0;
        tracingToolCalls.forEach((entry) => {
            if (entry.toolCallsByName.has(tool)) {
                usageCount += 1;
            }
        });

        return { toolName: tool, usageCount };
    });
}

function buildTraceScoreData(tracingToolCalls) {
    const data = [];
    tracingToolCalls.forEach((entry, tracingId) => {
        data.push({
            id: tracingId,
            score: entry.score,
        });
    });
    return data;
}

function buildTracingToolIndex(tracings) {
    const tools = new Set();
    const tracingToolCalls = new Map();

    tracings.forEach((tracing) => {
        const toolCallsByName = new Map();

        extractToolCallRecords(tracing).forEach((toolCall, index) => {
            const toolCallId = toolCall.id ?? `${tracing.id}-${index}`;
            const normalizedToolCall = {
                ...toolCall,
                id: toolCallId,
            };

            tools.add(normalizedToolCall.name);

            if (!toolCallsByName.has(normalizedToolCall.name)) {
                toolCallsByName.set(normalizedToolCall.name, []);
            }
            toolCallsByName.get(normalizedToolCall.name).push(normalizedToolCall);
        });

        tracingToolCalls.set(tracing.id, {
            toolCallsByName,
            score: getTracingScore(tracing),
        });
    });

    return {
        tools: Array.from(tools).sort(),
        tracingToolCalls,
    };
}

function formatToolCallList(calls, formatArgs) {
    return calls
        .map((toolCall, index) => {
            const status = toolCall.status ? `<strong>Status:</strong> ${toolCall.status}<br/>` : "";
            return [
                `<div style="margin-top:${index === 0 ? 4 : 8}px;">`,
                `<strong>Call ${index + 1}</strong><br/>`,
                status,
                `<pre style="margin:4px 0 0;font-family:Menlo,monospace;font-size:10px;color:#e2e8f0;white-space:pre-wrap;">${formatArgs(toolCall.args)}</pre>`,
                `</div>`,
            ].join("");
        })
        .join("");
}

function createTooltip(containerSelection) {
    const tooltip = containerSelection
        .append("div")
        .attr("class", "upset-tooltip")
        .style("position", "absolute")
        .style("pointer-events", "none")
        .style("background", "#0f172a")
        .style("color", "#f8fafc")
        .style("border-radius", "6px")
        .style("padding", "8px 10px")
        .style("font-size", "11px")
        .style("box-shadow", "0 8px 20px rgba(15,23,42,0.25)")
        .style("opacity", 0)
        .style("transition", "opacity 120ms ease");

    const showTooltip = (event, html) => {
        const [xPos, yPos] = d3.pointer(event, containerSelection.node());
        tooltip
            .style("opacity", 1)
            .html(html)
            .style("left", `${xPos + 14}px`)
            .style("top", `${yPos + 14}px`);
    };

    const hideTooltip = () => {
        tooltip.style("opacity", 0);
    };

    return { tooltip, showTooltip, hideTooltip };
}

function renderToolCoverageBars({
    group,
    data,
    xScale,
    yScale,
    glyphSystem,
}) {
    const barsGroup = group.append("g").attr("class", "tool-coverage");

    const bars = barsGroup
        .selectAll("rect")
        .data(data)
        .join("rect")
        .attr("x", (d) => xScale(d.toolName))
        .attr("y", (d) => yScale(d.usageCount))
        .attr("width", xScale.bandwidth())
        .attr("height", (d) => yScale(0) - yScale(d.usageCount))
        .attr("fill", "#111827");

    const yAxis = d3.axisLeft(yScale).ticks(5);
    const yAxisGroup = barsGroup
        .append("g")
        .attr("class", "y-axis")
        .call(yAxis);
    yAxisGroup.select(".domain").attr("stroke", "#bababa");
    yAxisGroup.selectAll("line").attr("stroke", "#bababa");
    yAxisGroup.selectAll("text").attr("fill", "#4b5563").style("font-size", "9px");

    const toolNameGroup = barsGroup
        .append("g")
        .attr("class", "tool-names-top");

    const toolLabels = toolNameGroup
        .selectAll("g.tool-label")
        .data(data)
        .join("g")
        .attr("class", "tool-label")
        .attr(
            "transform",
            (d) =>
                `translate(${xScale(d.toolName) + xScale.bandwidth() / 2},0)`
        );

    toolLabels.each(function (d) {
        const labelGroup = d3.select(this);
        const glyphType = glyphSystem.getGlyph(d.toolName);
        renderGlyph(labelGroup, glyphType, 0, -10, "#111827", 4);
    });

    const toolTexts = toolLabels
        .append("text")
        .attr("x", 6)
        .attr("y", -10)
        .attr("text-anchor", "start")
        .attr("fill", "#4b5563")
        .style("font-size", "10px")
        .attr("transform", () => `rotate(-60, 0, -12)`)
        .text((d) => d.toolName);

    const setColumnHighlight = (toolName) => {
        if (!toolName) {
            bars.attr("fill", "#111827");
            toolTexts.attr("fill", "#4b5563");
            toolLabels.selectAll("path, circle, rect").attr("fill", "#111827");
            return;
        }

        bars.attr("fill", (d) =>
            d.toolName === toolName ? "#0ea5e9" : "#111827"
        );
        toolTexts.attr("fill", (d) =>
            d.toolName === toolName ? "#0ea5e9" : "#4b5563"
        );
        toolLabels.each(function (d) {
            const labelGroup = d3.select(this);
            const isHighlighted = d.toolName === toolName;
            labelGroup
                .selectAll("path, circle, rect")
                .attr("fill", isHighlighted ? "#0ea5e9" : "#111827");
        });
    };

    const clearColumnHighlight = () => {
        bars.attr("fill", "#111827");
        toolTexts.attr("fill", "#4b5563");
        toolLabels.selectAll("path, circle, rect").attr("fill", "#111827");
    };

    return { setColumnHighlight, clearColumnHighlight };
}

function renderCoverageGrid({
    svg,
    group,
    tracings,
    tools,
    matrixWidth,
    matrixTop,
    matrixHeight,
    scoreWidth,
    xScale,
    traceScale,
    tracingToolCalls,
    glyphSystem,
    barHighlightControls,
    showTooltip,
    hideTooltip,
    formatArgs,
    onTracingSelect,
}) {
    const gridStroke = "rgba(15,23,42,0.2)";

    const highlightRow = group
        .append("rect")
        .attr("class", "matrix-highlight-row")
        .attr("x", 0)
        .attr("y", matrixTop)
        .attr("width", matrixWidth + scoreWidth)
        .attr("height", traceScale.bandwidth())
        .attr("rx", 4)
        .attr("fill", "rgba(14,165,233,0.12)")
        .style("opacity", 0)
        .style("pointer-events", "none");

    const highlightCol = group
        .append("rect")
        .attr("class", "matrix-highlight-col")
        .attr("x", 0)
        .attr("y", matrixTop)
        .attr("width", xScale.bandwidth())
        .attr("height", matrixHeight)
        .attr("fill", "rgba(15,23,42,0.06)")
        .style("opacity", 0)
        .style("pointer-events", "none");

    // Horizontal lines
    group
        .append("g")
        .attr("class", "matrix-rows")
        .selectAll("line")
        .data(tracings)
        .join("line")
        .attr("x1", 0)
        .attr("x2", matrixWidth)
        .attr("y1", (t) => traceScale(t.id) + traceScale.bandwidth() / 2)
        .attr("y2", (t) => traceScale(t.id) + traceScale.bandwidth() / 2)
        .attr("stroke", gridStroke)
        .attr("stroke-width", 1);

    // Vertical lines
    group
        .append("g")
        .attr("class", "matrix-cols")
        .selectAll("line")
        .data(tools)
        .join("line")
        .attr("y1", matrixTop)
        .attr("y2", matrixTop + matrixHeight)
        .attr("x1", (tool) => xScale(tool) + xScale.bandwidth() / 2)
        .attr("x2", (tool) => xScale(tool) + xScale.bandwidth() / 2)
        .attr("stroke", gridStroke)
        .attr("stroke-width", 1);

    const matrixGroup = group.append("g").attr("class", "matrix-dots");

    matrixGroup
        .selectAll("g.intersection-col")
        .data(tools)
        .join("g")
        .attr("class", "intersection-col")
        .attr("transform", (tool) => `translate(${xScale(tool) + xScale.bandwidth() / 2},0)`)
        .each(function (tool) {
            const column = d3.select(this);

            tracings.forEach((tracing) => {
                const entry = tracingToolCalls.get(tracing.id);
                const callsForTool = entry?.toolCallsByName.get(tool) || [];
                const yCenter =
                    traceScale(tracing.id) + traceScale.bandwidth() / 2;

                const active = callsForTool.length > 0;

                if (active) {
                    const glyphType = glyphSystem.getGlyph(tool);
                    const toolGroup = glyphSystem.getGroup(tool);
                    const cellGroup = column
                        .append("g")
                        .attr("transform", `translate(0,${yCenter})`)
                        .style("cursor", "pointer");

                    renderGlyph(cellGroup, glyphType, 0, 0, "#111827", 5);

                    if (callsForTool.length > 1) {
                        cellGroup
                            .append("circle")
                            .attr("cx", 8)
                            .attr("cy", -8)
                            .attr("r", 7)
                            .attr("fill", "#0ea5e9")
                            .attr("stroke", "#f8fafc")
                            .attr("stroke-width", 1.5)
                            .style("pointer-events", "none");

                        cellGroup
                            .append("text")
                            .attr("x", 8)
                            .attr("y", -8)
                            .attr("dy", "0.35em")
                            .attr("text-anchor", "middle")
                            .attr("fill", "#ffffff")
                            .style("font-size", "8px")
                            .style("font-weight", "700")
                            .style("pointer-events", "none")
                            .text(callsForTool.length);
                    }

                    const score = entry?.score ?? tracing.score;
                    const tooltipHtml = [
                        `<strong>Tool:</strong> ${tool}`,
                        `<strong>Group:</strong> ${toolGroup}`,
                        `<strong>Run:</strong> #${tracing.id}`,
                        score !== undefined
                            ? `<strong>Score:</strong> ${score}`
                            : null,
                        `<strong>Calls:</strong> ${callsForTool.length}`,
                        `<div style="margin-top:4px;max-width:340px;max-height:220px;overflow:auto;">${formatToolCallList(callsForTool, formatArgs)}</div>`,
                    ]
                        .filter(Boolean)
                        .join("<br/>");

                    cellGroup
                        .on("mouseenter", (event) => {
                            setRowHighlight(tracing.id);
                            setColumnHighlight(tool);
                            showTooltip(event, tooltipHtml);
                        })
                        .on("mousemove", (event) => {
                            showTooltip(event, tooltipHtml);
                        })
                        .on("mouseleave", () => {
                            hideTooltip();
                        })
                        .on("click", () => {
                            onTracingSelect?.(tracing.id);
                        });
                }
            });
        });

    let rowHighlightListener = () => { };

    const setRowHighlight = (tracingId) => {
        const yPos = traceScale(tracingId);
        if (yPos === undefined) {
            highlightRow.style("opacity", 0);
            rowHighlightListener(null);
            return;
        }
        highlightRow
            .attr("y", yPos)
            .attr("height", traceScale.bandwidth())
            .style("opacity", 1);
        rowHighlightListener(tracingId);
    };

    const clearRowHighlight = () => {
        highlightRow.style("opacity", 0);
        rowHighlightListener(null);
    };

    const setColumnHighlight = (tool) => {
        const xPos = xScale(tool);
        if (xPos === undefined) {
            highlightCol.style("opacity", 0);
            barHighlightControls?.clearColumnHighlight();
            return;
        }
        highlightCol
            .attr("x", xPos)
            .attr("width", xScale.bandwidth())
            .style("opacity", 1);
        barHighlightControls?.setColumnHighlight(tool);
    };

    const clearColumnHighlight = () => {
        highlightCol.style("opacity", 0);
        barHighlightControls?.clearColumnHighlight();
    };

    const clearAllHighlights = () => {
        clearRowHighlight();
        clearColumnHighlight();
    };

    const registerExternalRowHighlight = (listener) => {
        rowHighlightListener = listener || (() => { });
    };

    const findTracingAtY = (yPos) =>
        tracings.find((tracing) => {
            const rowStart = traceScale(tracing.id);
            if (rowStart === undefined) return false;
            return (
                yPos >= rowStart && yPos <= rowStart + traceScale.bandwidth()
            );
        });

    const findToolAtX = (xPos) =>
        tools.find((toolName) => {
            const colStart = xScale(toolName);
            if (colStart === undefined) return false;
            return (
                xPos >= colStart && xPos <= colStart + xScale.bandwidth()
            );
        });

    const handlePointerMove = (event) => {
        const [mx, my] = d3.pointer(event, group.node());
        const withinBand =
            mx >= 0 &&
            mx <= matrixWidth + scoreWidth &&
            my >= matrixTop &&
            my <= matrixTop + matrixHeight;

        if (!withinBand) {
            clearAllHighlights();
            return;
        }

        const hoveredTracing = findTracingAtY(my);
        if (hoveredTracing) {
            setRowHighlight(hoveredTracing.id);
        } else {
            clearRowHighlight();
        }

        if (mx <= matrixWidth) {
            const hoveredTool = findToolAtX(mx);
            if (hoveredTool) {
                setColumnHighlight(hoveredTool);
            } else {
                clearColumnHighlight();
            }
        } else {
            clearColumnHighlight();
        }
    };

    svg.on("mousemove", handlePointerMove)
        .on("mouseleave", () => {
            hideTooltip();
            clearAllHighlights();
        });

    return {
        setRowHighlight,
        clearRowHighlight,
        setColumnHighlight,
        clearColumnHighlight,
        clearAllHighlights,
        registerExternalRowHighlight,
    };
}

function renderScoreRail({
    group,
    data,
    traceScale,
    scoreX,
    matrixTop,
    matrixWidth,
    scoreWidth,
    showTooltip,
    hideTooltip,
    formatScore,
    onRowFocus,
    onRowBlur,
    onRowSelect,
}) {
    const scoreGroup = group
        .append("g")
        .attr("class", "score-rail")
        .attr("transform", `translate(${matrixWidth},0)`);

    const scoreAxis = d3.axisTop(scoreX).ticks(4).tickSize(-6);
    const scoreAxisGroup = scoreGroup
        .append("g")
        .attr("transform", `translate(0,${matrixTop - 12})`)
        .call(scoreAxis);
    scoreAxisGroup.select(".domain").remove();
    scoreAxisGroup.selectAll("line").attr("stroke", "#cbd5f5");
    scoreAxisGroup
        .selectAll("text")
        .attr("fill", "#4b5563")
        .style("font-size", "9px");

    scoreGroup
        .append("text")
        .attr("x", scoreWidth / 2)
        .attr("y", matrixTop - 24)
        .attr("fill", "#4b5563")
        .attr("font-size", 11)
        .attr("text-anchor", "middle")
        .text("Run Score");

    const scoreBarBaseFill = "#38bdf8";
    const scoreBarHighlightFill = "#0284c7";
    const scoreLabelBaseColor = "#475569";
    const scoreLabelHighlightColor = "#0f172a";

    const scoreBars = scoreGroup
        .selectAll("rect.score-bar")
        .data(data)
        .join("rect")
        .attr("class", "score-bar")
        .attr("x", 0)
        .attr("y", (d) => traceScale(d.id))
        .attr("height", traceScale.bandwidth())
        .attr("width", (d) => scoreX(d.score ?? 0))
        .attr("fill", scoreBarBaseFill)
        .attr("rx", 3);

    const scoreLabels = scoreGroup
        .selectAll("text.score-value")
        .data(data)
        .join("text")
        .attr("class", "score-value")
        .attr("x", (d) => scoreX(d.score ?? 0) + 6)
        .attr("y", (d) => traceScale(d.id) + traceScale.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("fill", scoreLabelBaseColor)
        .style("font-size", "10px")
        .text((d) => formatScore(d.score));

    const setRowHighlight = (tracingId) => {
        scoreBars.attr("fill", (d) =>
            d.id === tracingId ? scoreBarHighlightFill : scoreBarBaseFill
        );

        scoreLabels
            .attr("fill", (d) =>
                d.id === tracingId ? scoreLabelHighlightColor : scoreLabelBaseColor
            )
            .attr("font-weight", (d) => (d.id === tracingId ? 600 : 400));
    };

    const scoreTooltipContent = (d) =>
        [`<strong>Run:</strong> #${d.id}`, `<strong>Score:</strong> ${formatScore(d.score)}`].join("<br/>");

    scoreBars
        .on("mouseenter", (event, d) => {
            onRowFocus?.(d.id);
            showTooltip(event, scoreTooltipContent(d));
        })
        .on("mousemove", (event, d) => {
            showTooltip(event, scoreTooltipContent(d));
        })
        .on("mouseleave", () => {
            hideTooltip();
            onRowBlur?.();
        })
        .on("click", (_, d) => {
            onRowSelect?.(d.id);
        });

    return { setRowHighlight };
}


export function renderUpsetPlot(container, data, toolSets = {}, options = {}) {
    if (!container) return;

    const tracings = prepareTracings(data);
    const { tools, tracingToolCalls } = buildTracingToolIndex(tracings);
    const glyphSystem = createGlyphSystem(toolSets);
    const upperBarChartData = buildToolCoverageData(tools, tracingToolCalls);
    const lowerBarChartData = buildTraceScoreData(tracingToolCalls);

    const width = options.width ?? Math.max(container.clientWidth || 0, 640);
    const margin = {
        top: 80,
        right: 24,
        bottom: 40,
        left: 80,
        ...(options.margin || {}),
    };

    const minRowHeight = 20;
    const topBarHeightFixed = 200;
    const numTracings = tracings.length;
    const matrixHeightRequired = Math.max(
        numTracings * minRowHeight,
        100
    );
    const calculatedHeight =
        margin.top +
        topBarHeightFixed +
        matrixHeightRequired +
        margin.bottom;
    const height = options.height ?? calculatedHeight;

    const containerSelection = d3.select(container);

    containerSelection.selectAll("*").remove();
    containerSelection.style("position", "relative");

    const svg = containerSelection
        .append("svg")
        .attr("width", width)
        .attr("height", height);

    const { showTooltip, hideTooltip } = createTooltip(containerSelection);

    const formatArgs = (args) => {
        if (!args) return "None";
        try {
            return JSON.stringify(args, null, 2);
        } catch {
            return String(args);
        }
    };

    const formatScore = (value) => {
        if (value === null || value === undefined || Number.isNaN(value)) {
            return "—";
        }
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric.toFixed(3) : "—";
    };

    if (!data || data.length === 0) {
        svg
            .append("text")
            .attr("x", width / 2)
            .attr("y", height / 2)
            .attr("text-anchor", "middle")
            .attr("fill", "#6b7280")
            .text("No data");
        return;
    }

    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const topBarHeight = topBarHeightFixed;
    const matrixTop = topBarHeight;
    const matrixHeight = innerHeight - topBarHeight;

    const matrixWidth = innerWidth * 0.75;
    const scoreWidth = innerWidth - matrixWidth;

    const x = d3
        .scaleBand()
        .domain(tools)
        .range([0, matrixWidth])
        .padding(0.3);

    const maxToolUsage = d3.max(upperBarChartData, (d) => d.usageCount) || 1;
    const yBar = d3
        .scaleLinear()
        .domain([0, maxToolUsage])
        .nice()
        .range([topBarHeight, 0]);

    const barHighlightControls = renderToolCoverageBars({
        group: g,
        data: upperBarChartData,
        xScale: x,
        yScale: yBar,
        glyphSystem,
    });

    const traceScale = d3
        .scaleBand()
        .domain(tracings.map((t) => t.id))
        .range([matrixTop, matrixTop + matrixHeight])
        .paddingInner(0.4);

    const maxScore = d3.max(lowerBarChartData, (d) => d.score) || 1;
    const scoreX = d3
        .scaleLinear()
        .domain([0, maxScore])
        .range([0, scoreWidth]);

    const matrixControls = renderCoverageGrid({
        svg,
        group: g,
        tracings,
        tools,
        matrixWidth,
        matrixTop,
        matrixHeight,
        scoreWidth,
        xScale: x,
        traceScale,
        tracingToolCalls,
        glyphSystem,
        barHighlightControls,
        showTooltip,
        hideTooltip,
        formatArgs,
        onTracingSelect: options.onTracingSelect,
    });

    g.append("g")
        .selectAll("text.set-label")
        .data(lowerBarChartData)
        .join("text")
        .attr("class", "set-label")
        .attr("x", -12)
        .attr("y", (d) => traceScale(d.id) + traceScale.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "end")
        .attr("fill", "#111827")
        .style("font-size", "10px")
        .style("cursor", options.onTracingSelect ? "pointer" : null)
        .on("click", (_, d) => {
            options.onTracingSelect?.(d.id);
        })
        .text((d) => d.id);

    const scoreControls = renderScoreRail({
        group: g,
        data: lowerBarChartData,
        traceScale,
        scoreX,
        matrixTop,
        matrixWidth,
        scoreWidth,
        showTooltip,
        hideTooltip,
        formatScore,
        onRowFocus: (tracingId) => matrixControls.setRowHighlight(tracingId),
        onRowBlur: () => matrixControls.clearRowHighlight(),
        onRowSelect: options.onTracingSelect,
    });

    matrixControls.registerExternalRowHighlight(scoreControls.setRowHighlight);
}
