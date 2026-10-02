(function () {
  "use strict";

  const LOG_PREFIX = "[Grouped Tags View]";

  // Children are derived from parents, so one query is enough.
  const TAGS_QUERY = `
    query GroupedTagsViewTags {
      findTags(filter: { per_page: -1 }) {
        tags {
          id
          name
          sort_name
          image_path
          parents { id }
        }
      }
    }
  `;

  async function fetchTags() {
    const response = await fetch("graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query: TAGS_QUERY }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result.errors && result.errors.length) {
      throw new Error(result.errors.map((e) => e.message).join("; "));
    }
    return result.data.findTags.tags;
  }

  function sortKey(tag) {
    return (tag.sort_name || tag.name).toLowerCase();
  }

  function compareTags(a, b) {
    return sortKey(a).localeCompare(sortKey(b));
  }

  // Builds a lookup with parent and child ids for every tag.
  // Kept as a graph (not a fixed two-level list) so deeper levels can be added later.
  function buildTagGraph(tags) {
    const byId = new Map();
    for (const tag of tags) {
      byId.set(tag.id, {
        id: tag.id,
        name: tag.name,
        sort_name: tag.sort_name,
        image_path: tag.image_path,
        parentIds: tag.parents.map((p) => p.id),
        childIds: [],
      });
    }
    for (const node of byId.values()) {
      for (const parentId of node.parentIds) {
        const parent = byId.get(parentId);
        if (parent) parent.childIds.push(node.id);
      }
    }
    return byId;
  }

  // V1 grouping: every tag with children becomes a group of its direct children.
  // A tag with several parents appears in each of their groups.
  // Tags without parent and without children end up in "uncategorized".
  function buildGroups(byId) {
    const groups = [];
    const uncategorized = [];
    for (const node of byId.values()) {
      if (node.childIds.length > 0) {
        groups.push({
          parent: node,
          children: node.childIds.map((id) => byId.get(id)).sort(compareTags),
        });
      } else if (node.parentIds.length === 0) {
        uncategorized.push(node);
      }
    }
    groups.sort((a, b) => compareTags(a.parent, b.parent));
    uncategorized.sort(compareTags);
    return { groups, uncategorized };
  }

  function logGroups(tagCount, { groups, uncategorized }) {
    const lines = [];
    for (const group of groups) {
      lines.push(`${group.parent.name} (${group.children.length})`);
      for (const child of group.children) {
        lines.push(`  - ${child.name}`);
      }
    }
    if (uncategorized.length) {
      lines.push(`Sonstige (${uncategorized.length})`);
      for (const tag of uncategorized) {
        lines.push(`  - ${tag.name}`);
      }
    }
    console.log(
      `${LOG_PREFIX} ${tagCount} Tags, ${groups.length} Gruppen, ${uncategorized.length} ohne Gruppe\n` +
        lines.join("\n")
    );
  }

  async function init() {
    console.log(LOG_PREFIX, "loaded");
    try {
      const tags = await fetchTags();
      const byId = buildTagGraph(tags);
      logGroups(tags.length, buildGroups(byId));
    } catch (error) {
      console.error(LOG_PREFIX, "Grouped Tags View konnte die Tags nicht laden.", error);
    }
  }

  init();
})();
