"use client";

import * as d3 from "d3";
import {
    createGlyphSystem,
    extractToolCallRecords,
    getTracingScore,
    prepareTracings,
    renderGlyph,
} from "./visualization_shared";

const BAR_FILL = "#111827";
const BAR_HIGHLIGHT_FILL = "#38bdf8";
const GROUP_GAP_ROWS = 1;

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

function solveLinearSystem(matrix, vector) {
    const size = vector.length;
    const augmented = matrix.map((row, index) => [...row, vector[index]]);

    for (let pivotIndex = 0; pivotIndex < size; pivotIndex += 1) {
        let pivotRow = pivotIndex;

        for (let rowIndex = pivotIndex + 1; rowIndex < size; rowIndex += 1) {
            if (
                Math.abs(augmented[rowIndex][pivotIndex]) >
                Math.abs(augmented[pivotRow][pivotIndex])
            ) {
                pivotRow = rowIndex;
            }
        }

        if (pivotRow !== pivotIndex) {
            [augmented[pivotIndex], augmented[pivotRow]] = [
                augmented[pivotRow],
                augmented[pivotIndex],
            ];
        }

        const pivot = augmented[pivotIndex][pivotIndex];
        if (Math.abs(pivot) < 1e-9) {
            return Array(size).fill(0);
        }

        for (let columnIndex = pivotIndex; columnIndex <= size; columnIndex += 1) {
            augmented[pivotIndex][columnIndex] /= pivot;
        }

        for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
            if (rowIndex === pivotIndex) {
                continue;
            }

            const factor = augmented[rowIndex][pivotIndex];
            for (let columnIndex = pivotIndex; columnIndex <= size; columnIndex += 1) {
                augmented[rowIndex][columnIndex] -=
                    factor * augmented[pivotIndex][columnIndex];
            }
        }
    }

    return augmented.map((row) => row[size]);
}

function buildToolImpactData(tools, tracings, tracingToolCalls) {
    if (tools.length === 0 || tracings.length === 0) {
        return [];
    }

    const rows = tracings.map((tracing) => {
        const toolCallsByName = tracingToolCalls.get(tracing.id)?.toolCallsByName;
        return tools.map((tool) => (toolCallsByName?.has(tool) ? 1 : 0));
    });
    const scores = tracings.map((tracing) => getTracingScore(tracing));
    const featureMeans = tools.map(
        (_, toolIndex) => d3.mean(rows, (row) => row[toolIndex]) ?? 0
    );
    const scoreMean = d3.mean(scores) ?? 0;
    const gram = Array.from({ length: tools.length }, () =>
        Array(tools.length).fill(0)
    );
    const rhs = Array(tools.length).fill(0);

    rows.forEach((row, rowIndex) => {
        const centeredScore = scores[rowIndex] - scoreMean;
        const centeredRow = row.map((value, toolIndex) => value - featureMeans[toolIndex]);

        centeredRow.forEach((value, leftIndex) => {
            rhs[leftIndex] += value * centeredScore;

            for (let rightIndex = leftIndex; rightIndex < tools.length; rightIndex += 1) {
                gram[leftIndex][rightIndex] += value * centeredRow[rightIndex];
            }
        });
    });

    gram.forEach((row, leftIndex) => {
        for (let rightIndex = leftIndex + 1; rightIndex < tools.length; rightIndex += 1) {
            gram[rightIndex][leftIndex] = row[rightIndex];
        }
        row[leftIndex] += 1;
    });

    const coefficients = solveLinearSystem(gram, rhs);

    return tools.map((tool, toolIndex) => {
        const presentScores = [];
        const absentScores = [];
        let usageCount = 0;
        let absoluteContributionSum = 0;

        rows.forEach((row, rowIndex) => {
            const present = row[toolIndex] === 1;
            const contribution =
                coefficients[toolIndex] * (row[toolIndex] - featureMeans[toolIndex]);

            absoluteContributionSum += Math.abs(contribution);

            if (present) {
                usageCount += 1;
                presentScores.push(scores[rowIndex]);
                return;
            }

            absentScores.push(scores[rowIndex]);
        });

        const impactAbs = absoluteContributionSum / rows.length;
        const direction = Math.sign(coefficients[toolIndex] || 0);

        return {
            toolName: tool,
            usageCount,
            impact: direction * impactAbs,
            impactAbs,
            meanPresentScore:
                presentScores.length > 0 ? d3.mean(presentScores) : null,
            meanAbsentScore:
                absentScores.length > 0 ? d3.mean(absentScores) : null,
        };
    });
}

function buildTraceScoreData(tracings, tracingToolCalls) {
    return tracings.map((tracing) => ({
        id: tracing.id,
        label: traceLabel(tracing),
        tracing,
        score: tracingToolCalls.get(tracing.id)?.score ?? getTracingScore(tracing),
    }));
}

function compareLabels(a, b) {
    return String(a).localeCompare(String(b), undefined, {
        numeric: true,
        sensitivity: "base",
    });
}

function shortenText(value, maxLength = 34) {
    const text = String(value ?? "");
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function compactTraceId(id) {
    const text = String(id ?? "");
    const suffix = text.split(":").at(-1) || text;
    return shortenText(suffix, suffix.includes("-") ? 9 : 18);
}

function traceLabel(tracing) {
    return tracing.config
        ? `${shortenText(tracing.config, 10)}:${compactTraceId(tracing.id)}`
        : `#${compactTraceId(tracing.id)}`;
}

function traceMetadataRows(tracing) {
    const label = traceLabel(tracing);
    return [
        `<strong>Run:</strong> ${label}`,
        String(tracing.id) !== label ? `<strong>ID:</strong> ${tracing.id}` : null,
        tracing.category ? `<strong>Category:</strong> ${tracing.category}` : null,
        tracing.subcategory ? `<strong>Subcategory:</strong> ${tracing.subcategory}` : null,
        tracing.task ? `<strong>Task:</strong> ${tracing.task}` : null,
    ].filter(Boolean);
}

function getTracingGroupValue(tracing, groupBy) {
    if (!groupBy) {
        return "";
    }

    const value = tracing?.[groupBy];
    return value === null || value === undefined || value === "" ? "unknown" : String(value);
}

function orderTracings(tracings, groupBy, collapsedGroups = []) {
    const byScore = (a, b) =>
        getTracingScore(b) - getTracingScore(a) || compareLabels(a.id, b.id);
    const collapsedGroupSet = new Set(collapsedGroups);

    if (!groupBy) {
        const ordered = [...tracings].sort(byScore);
        return {
            tracings: ordered,
            groups: [],
            domain: ordered.map((tracing) => tracing.id),
        };
    }

    const groups = d3
        .groups(tracings, (tracing) => getTracingGroupValue(tracing, groupBy))
        .map(([label, items]) => ({
            label,
            items: items.slice().sort(byScore),
            topScore: d3.max(items, (item) => getTracingScore(item)) ?? 0,
        }))
        .sort(
            (a, b) => b.topScore - a.topScore || compareLabels(a.label, b.label)
        );

    const orderedTracings = [];
    const orderedGroups = [];
    const domain = [];

    groups.forEach(({ label, items }) => {
        if (items.length === 0) {
            return;
        }

        const visibleItems = collapsedGroupSet.has(label) ? items.slice(0, 1) : items;
        const gapIds = Array.from(
            { length: GROUP_GAP_ROWS },
            (_, index) => `__gap__${label}__${index}`
        );

        orderedGroups.push({
            label,
            collapsed: collapsedGroupSet.has(label),
            gapIds,
        });
        orderedTracings.push(...visibleItems);
        domain.push(...gapIds, ...visibleItems.map((item) => item.id));
    });

    return {
        tracings: orderedTracings,
        groups: orderedGroups,
        domain,
    };
}

function orderTools(tools, glyphSystem) {
    const groupOrder = new Map(
        [...glyphSystem.getAllGroups(), "unknown"].map((group, index) => [group, index])
    );

    return [...tools].sort((a, b) => {
        const groupA = glyphSystem.getGroup(a);
        const groupB = glyphSystem.getGroup(b);
        const rankA = groupOrder.get(groupA) ?? groupOrder.size;
        const rankB = groupOrder.get(groupB) ?? groupOrder.size;

        if (rankA !== rankB) {
            return rankA - rankB;
        }

        return compareLabels(a, b);
    });
}

function getToolGroupBreaks(tools, glyphSystem) {
    const breaks = [];

    for (let index = 1; index < tools.length; index += 1) {
        if (glyphSystem.getGroup(tools[index - 1]) !== glyphSystem.getGroup(tools[index])) {
            breaks.push(tools[index]);
        }
    }

    return breaks;
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
        .style("position", "fixed")
        .style("pointer-events", "none")
        .style("background", "#0f172a")
        .style("color", "#f8fafc")
        .style("border-radius", "6px")
        .style("padding", "8px 10px")
        .style("font-size", "11px")
        .style("box-shadow", "0 8px 20px rgba(15,23,42,0.25)")
        .style("max-width", "360px")
        .style("max-height", "280px")
        .style("overflow", "hidden")
        .style("overflow-wrap", "anywhere")
        .style("opacity", 0)
        .style("transition", "opacity 120ms ease")
        .style("z-index", 50);

    const showTooltip = (event, html) => {
        const padding = 12;
        const node = tooltip.node();

        tooltip
            .style("opacity", 1)
            .html(html);

        const width = node?.offsetWidth || 360;
        const height = node?.offsetHeight || 120;
        const xPos = Math.min(event.clientX + 14, window.innerWidth - width - padding);
        const yPos = Math.min(event.clientY + 14, window.innerHeight - height - padding);

        tooltip
            .style("left", `${Math.max(padding, xPos)}px`)
            .style("top", `${Math.max(padding, yPos)}px`);
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
    mode,
    traceCount,
    showTooltip,
    hideTooltip,
    formatScore,
}) {
    const barsGroup = group.append("g").attr("class", "tool-coverage");
    const zeroY = yScale(0);

    const bars = barsGroup
        .selectAll("rect")
        .data(data)
        .join("rect")
        .attr("x", (d) => xScale(d.toolName))
        .attr("y", (d) =>
            mode === "impact"
                ? yScale(Math.max(d.impact, 0))
                : yScale(d.usageCount)
        )
        .attr("width", xScale.bandwidth())
        .attr("height", (d) =>
            mode === "impact"
                ? Math.abs(yScale(d.impact) - zeroY)
                : zeroY - yScale(d.usageCount)
        )
        .attr("fill", BAR_FILL);

    if (mode === "impact") {
        barsGroup
            .append("line")
            .attr("x1", 0)
            .attr("x2", xScale.range()[1])
            .attr("y1", zeroY)
            .attr("y2", zeroY)
            .attr("stroke", "#bababa");
    }

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
            bars.attr("fill", BAR_FILL);
            toolTexts.attr("fill", "#4b5563");
            toolLabels.selectAll("path, circle, rect").attr("fill", BAR_FILL);
            return;
        }

        bars.attr("fill", (d) =>
            d.toolName === toolName ? BAR_HIGHLIGHT_FILL : BAR_FILL
        );
        toolTexts.attr("fill", (d) =>
            d.toolName === toolName ? BAR_HIGHLIGHT_FILL : "#4b5563"
        );
        toolLabels.each(function (d) {
            const labelGroup = d3.select(this);
            const isHighlighted = d.toolName === toolName;
            labelGroup
                .selectAll("path, circle, rect")
                .attr("fill", isHighlighted ? BAR_HIGHLIGHT_FILL : BAR_FILL);
        });
    };

    const clearColumnHighlight = () => {
        bars.attr("fill", BAR_FILL);
        toolTexts.attr("fill", "#4b5563");
        toolLabels.selectAll("path, circle, rect").attr("fill", BAR_FILL);
    };

    const formatSigned = d3.format("+.3f");
    const tooltipContent = (datum) => {
        if (mode === "impact") {
            return [
                `<strong>Tool:</strong> ${datum.toolName}`,
                `<strong>Group:</strong> ${glyphSystem.getGroup(datum.toolName)}`,
                `<strong>Approx. Shapley impact:</strong> ${formatSigned(datum.impact)}`,
                `<strong>|Impact|:</strong> ${formatScore(datum.impactAbs)}`,
                `<strong>Runs with tool:</strong> ${datum.usageCount}/${traceCount}`,
                `<strong>Mean score when present:</strong> ${formatScore(datum.meanPresentScore)}`,
                `<strong>Mean score when absent:</strong> ${formatScore(datum.meanAbsentScore)}`,
            ].join("<br/>");
        }

        return [
            `<strong>Tool:</strong> ${datum.toolName}`,
            `<strong>Group:</strong> ${glyphSystem.getGroup(datum.toolName)}`,
            `<strong>Runs with tool:</strong> ${datum.usageCount}/${traceCount}`,
        ].join("<br/>");
    };

    const bindTooltip = (selection) => {
        selection
            .on("mouseenter", (event, datum) => {
                setColumnHighlight(datum.toolName);
                showTooltip(event, tooltipContent(datum));
            })
            .on("mousemove", (event, datum) => {
                showTooltip(event, tooltipContent(datum));
            })
            .on("mouseleave", () => {
                hideTooltip();
                clearColumnHighlight();
            });
    };

    bindTooltip(bars);
    bindTooltip(toolLabels);

    return { setColumnHighlight, clearColumnHighlight };
}

function renderToolGroupBreaks({
    group,
    breaks,
    tools,
    xScale,
    height,
}) {
    if (breaks.length === 0) {
        return;
    }

    group
        .append("g")
        .attr("class", "tool-group-breaks")
        .selectAll("line")
        .data(breaks)
        .join("line")
        .attr("x1", (tool) => {
            const currentX = xScale(tool);
            const previousX = xScale(tools[tools.indexOf(tool) - 1]);
            return ((currentX ?? 0) + (previousX ?? 0) + xScale.bandwidth()) / 2;
        })
        .attr("x2", (tool) => {
            const currentX = xScale(tool);
            const previousX = xScale(tools[tools.indexOf(tool) - 1]);
            return ((currentX ?? 0) + (previousX ?? 0) + xScale.bandwidth()) / 2;
        })
        .attr("y1", 0)
        .attr("y2", height)
        .attr("stroke", "#a1a1aa")
        .attr("stroke-dasharray", "2 4");
}

function renderTraceGroupBreaks({
    group,
    groups,
    traceScale,
    width,
    onGroupToggle,
    onGroupSelect,
}) {
    if (groups.length === 0) {
        return;
    }

    const getGapCenter = (item) =>
        d3.mean(
            item.gapIds,
            (gapId) => (traceScale(gapId) ?? 0) + traceScale.bandwidth() / 2
        ) ?? 0;

    group
        .append("g")
        .attr("class", "trace-group-breaks")
        .selectAll("line")
        .data(groups)
        .join("line")
        .attr("x1", 0)
        .attr("x2", width)
        .attr("y1", getGapCenter)
        .attr("y2", getGapCenter)
        .attr("stroke", "#a1a1aa")
        .attr("stroke-dasharray", "2 4");

    const labels = group
        .append("g")
        .attr("class", "trace-group-labels")
        .selectAll("g")
        .data(groups)
        .join("g")
        .attr("transform", (item) => `translate(-12,${getGapCenter(item)})`);

    labels
        .append("text")
        .attr("dy", "0.35em")
        .attr("text-anchor", "end")
        .attr("fill", "#71717a")
        .style("font-size", "10px")
        .selectAll("tspan")
        .data((item) => [
            { item, text: item.collapsed ? "[+]" : "[-]", action: "toggle" },
            { item, text: ` ${shortenText(item.label)}`, action: "select" },
        ])
        .join("tspan")
        .style("cursor", (part) =>
            part.action === "toggle" && onGroupToggle
                ? "pointer"
                : part.action === "select" && (onGroupSelect || onGroupToggle)
                  ? "pointer"
                  : null
        )
        .text((part) => part.text)
        .on("click", (event, part) => {
            event.stopPropagation();
            if (part.action === "toggle") {
                onGroupToggle?.(part.item.label);
                return;
            }
            if (onGroupSelect) {
                onGroupSelect(part.item.label);
                return;
            }
            onGroupToggle?.(part.item.label);
        });

    labels.append("title").text((item) => item.label);
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
    selectedTracingColors,
    onTracingSelect,
}) {
    const gridStroke = "rgba(15,23,42,0.2)";

    group
        .append("g")
        .attr("class", "matrix-selected-rows")
        .selectAll("rect")
        .data(tracings.filter((tracing) => selectedTracingColors?.[tracing.id]))
        .join("rect")
        .attr("x", 0)
        .attr("y", (tracing) => traceScale(tracing.id))
        .attr("width", matrixWidth + scoreWidth)
        .attr("height", traceScale.bandwidth())
        .attr("rx", 4)
        .attr("fill", (tracing) => selectedTracingColors[tracing.id])
        .style("pointer-events", "none");

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
                        ...traceMetadataRows(tracing),
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

    const scoreBarBaseFill = BAR_FILL;
    const scoreBarHighlightFill = BAR_HIGHLIGHT_FILL;
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
        .attr("fill", scoreBarBaseFill);

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
        [
            ...traceMetadataRows(d.tracing),
            `<strong>Score:</strong> ${formatScore(d.score)}`,
        ].join("<br/>");

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
    const topChartMode = options.topChartMode === "impact" ? "impact" : "usage";
    const glyphSystem = createGlyphSystem(toolSets);
    const { tools, tracingToolCalls } = buildTracingToolIndex(tracings);
    const orderedTracings = orderTracings(
        tracings,
        options.rowGroupBy,
        options.collapsedGroups
    );
    const orderedTools = orderTools(tools, glyphSystem);
    const toolGroupBreaks = getToolGroupBreaks(orderedTools, glyphSystem);
    const upperBarChartData =
        topChartMode === "impact"
            ? buildToolImpactData(orderedTools, tracings, tracingToolCalls)
            : buildToolCoverageData(orderedTools, tracingToolCalls);
    const lowerBarChartData = buildTraceScoreData(
        orderedTracings.tracings,
        tracingToolCalls
    );

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
    const numTracings = orderedTracings.domain.length;
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

    const matrixMaxHeight = options.matrixMaxHeight;
    if (
        typeof matrixMaxHeight === "number" &&
        matrixHeightRequired > matrixMaxHeight
    ) {
        svg.remove();

        const innerWidth = width - margin.left - margin.right;
        const matrixWidth = innerWidth * 0.75;
        const scoreWidth = innerWidth - matrixWidth;
        const lowerHeaderHeight = 36;
        const lowerHeight = lowerHeaderHeight + matrixHeightRequired + margin.bottom;
        const lowerViewportHeight = lowerHeaderHeight + matrixMaxHeight + margin.bottom;

        const x = d3
            .scaleBand()
            .domain(orderedTools)
            .range([0, matrixWidth])
            .padding(0.3);

        const maxToolValue =
            topChartMode === "impact"
                ? d3.max(upperBarChartData, (d) => Math.abs(d.impact)) || 1
                : d3.max(upperBarChartData, (d) => d.usageCount) || 1;
        const yBar = d3
            .scaleLinear()
            .domain(
                topChartMode === "impact"
                    ? [-maxToolValue, maxToolValue]
                    : [0, maxToolValue]
            )
            .nice()
            .range([topBarHeightFixed, 0]);

        const topSvg = containerSelection
            .append("svg")
            .attr("width", width)
            .attr("height", margin.top + topBarHeightFixed);
        const topGroup = topSvg
            .append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);

        renderToolGroupBreaks({
            group: topGroup,
            breaks: toolGroupBreaks,
            tools: orderedTools,
            xScale: x,
            height: topBarHeightFixed,
        });

        const barHighlightControls = renderToolCoverageBars({
            group: topGroup,
            data: upperBarChartData,
            xScale: x,
            yScale: yBar,
            glyphSystem,
            mode: topChartMode,
            traceCount: tracings.length,
            showTooltip,
            hideTooltip,
            formatScore,
        });

        const lowerWrapper = containerSelection
            .append("div")
            .style("max-height", `${lowerViewportHeight}px`)
            .style("overflow-y", "auto")
            .style("overflow-x", "hidden")
            .style("border-top", "1px solid rgb(228 228 231)");
        const lowerSvg = lowerWrapper
            .append("svg")
            .attr("width", width)
            .attr("height", lowerHeight);
        const lowerGroup = lowerSvg
            .append("g")
            .attr("transform", `translate(${margin.left},0)`);
        const matrixTop = lowerHeaderHeight;
        const matrixHeight = matrixHeightRequired;
        const traceScale = d3
            .scaleBand()
            .domain(orderedTracings.domain)
            .range([matrixTop, matrixTop + matrixHeight])
            .paddingInner(0.25);

        renderToolGroupBreaks({
            group: lowerGroup,
            breaks: toolGroupBreaks,
            tools: orderedTools,
            xScale: x,
            height: matrixTop + matrixHeight,
        });

        renderTraceGroupBreaks({
            group: lowerGroup,
            groups: orderedTracings.groups,
            traceScale,
            width: matrixWidth + scoreWidth,
            onGroupToggle: options.onGroupToggle,
            onGroupSelect: options.onGroupSelect,
        });

        const maxScore = d3.max(lowerBarChartData, (d) => d.score) || 1;
        const scoreX = d3
            .scaleLinear()
            .domain([0, maxScore])
            .range([0, scoreWidth]);

        const matrixControls = renderCoverageGrid({
            svg: lowerSvg,
            group: lowerGroup,
            tracings: orderedTracings.tracings,
            tools: orderedTools,
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
            selectedTracingColors: options.selectedTracingColors,
            onTracingSelect: options.onTracingSelect,
        });

        const lowerLabels = lowerGroup.append("g")
            .selectAll("text.set-label")
            .data(lowerBarChartData)
            .join("text")
            .attr("class", "set-label")
            .attr("x", -12)
            .attr("y", (d) => traceScale(d.id) + traceScale.bandwidth() / 2)
            .attr("dy", "0.35em")
            .attr("text-anchor", "end")
            .attr("fill", "#111827")
            .attr("font-weight", (d) =>
                options.selectedTracingColors?.[d.id] ? 600 : 400
            )
            .style("font-size", "10px")
            .style("cursor", options.onTracingSelect ? "pointer" : null)
            .on("click", (_, d) => {
                options.onTracingSelect?.(d.id);
            })
            .text((d) => d.label);

        lowerLabels.append("title").text((d) => String(d.id));

        const scoreControls = renderScoreRail({
            group: lowerGroup,
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
        .domain(orderedTools)
        .range([0, matrixWidth])
        .padding(0.3);

    const maxToolValue =
        topChartMode === "impact"
            ? d3.max(upperBarChartData, (d) => Math.abs(d.impact)) || 1
            : d3.max(upperBarChartData, (d) => d.usageCount) || 1;
    const yBar = d3
        .scaleLinear()
        .domain(
            topChartMode === "impact"
                ? [-maxToolValue, maxToolValue]
                : [0, maxToolValue]
        )
        .nice()
        .range([topBarHeight, 0]);

    renderToolGroupBreaks({
        group: g,
        breaks: toolGroupBreaks,
        tools: orderedTools,
        xScale: x,
        height: matrixTop + matrixHeight,
    });

    const barHighlightControls = renderToolCoverageBars({
        group: g,
        data: upperBarChartData,
        xScale: x,
        yScale: yBar,
        glyphSystem,
        mode: topChartMode,
        traceCount: tracings.length,
        showTooltip,
        hideTooltip,
        formatScore,
    });

    const traceScale = d3
        .scaleBand()
        .domain(orderedTracings.domain)
        .range([matrixTop, matrixTop + matrixHeight])
        .paddingInner(0.25);

    renderTraceGroupBreaks({
        group: g,
        groups: orderedTracings.groups,
        traceScale,
        width: matrixWidth + scoreWidth,
        onGroupToggle: options.onGroupToggle,
        onGroupSelect: options.onGroupSelect,
    });

    const maxScore = d3.max(lowerBarChartData, (d) => d.score) || 1;
    const scoreX = d3
        .scaleLinear()
        .domain([0, maxScore])
        .range([0, scoreWidth]);

    const matrixControls = renderCoverageGrid({
        svg,
        group: g,
        tracings: orderedTracings.tracings,
        tools: orderedTools,
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
        selectedTracingColors: options.selectedTracingColors,
        onTracingSelect: options.onTracingSelect,
    });

    const labels = g.append("g")
        .selectAll("text.set-label")
        .data(lowerBarChartData)
        .join("text")
        .attr("class", "set-label")
        .attr("x", -12)
        .attr("y", (d) => traceScale(d.id) + traceScale.bandwidth() / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "end")
        .attr("fill", "#111827")
        .attr("font-weight", (d) =>
            options.selectedTracingColors?.[d.id] ? 600 : 400
        )
        .style("font-size", "10px")
        .style("cursor", options.onTracingSelect ? "pointer" : null)
        .on("click", (_, d) => {
            options.onTracingSelect?.(d.id);
        })
        .text((d) => d.label);

    labels.append("title").text((d) => String(d.id));

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
