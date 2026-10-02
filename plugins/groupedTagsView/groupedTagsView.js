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

  const { React } = PluginApi;
  const h = React.createElement;

  function GroupList({ title, tags }) {
    return h(
      "section",
      { className: "gtv-group" },
      h("h3", null, `${title} (${tags.length})`),
      h(
        "ul",
        null,
        tags.map((tag) => h("li", { key: tag.id }, tag.name))
      )
    );
  }

  function GroupedTagsView() {
    const [state, setState] = React.useState({ status: "loading" });

    React.useEffect(() => {
      let cancelled = false;
      fetchTags()
        .then((tags) => {
          if (!cancelled) {
            setState({ status: "ready", data: buildGroups(buildTagGraph(tags)) });
          }
        })
        .catch((error) => {
          console.error(LOG_PREFIX, error);
          if (!cancelled) setState({ status: "error" });
        });
      return () => {
        cancelled = true;
      };
    }, []);

    let content;
    if (state.status === "loading") {
      content = h("p", null, "Lade Tags …");
    } else if (state.status === "error") {
      content = h("p", null, "Grouped Tags View konnte die Tags nicht laden.");
    } else {
      const { groups, uncategorized } = state.data;
      content = [
        groups.length === 0 &&
          h("p", { key: "empty" }, "Keine Tag-Gruppen vorhanden."),
        ...groups.map((group) =>
          h(GroupList, {
            key: group.parent.id,
            title: group.parent.name,
            tags: group.children,
          })
        ),
        uncategorized.length > 0 &&
          h(GroupList, { key: "uncategorized", title: "Sonstige", tags: uncategorized }),
      ];
    }

    return h("div", { id: "grouped-tags-view" }, content);
  }

  // FilteredTagList is only rendered on /tags (see Tags.tsx in Stash v0.31.1).
  // The original list stays below the grouped view for now.
  // React calls components with (props, context), Stash appends the render
  // result, so the result is always the last argument.
  PluginApi.patch.after("FilteredTagList", function (...args) {
    const result = args[args.length - 1];
    return h(React.Fragment, null, h(GroupedTagsView), result);
  });

  console.log(LOG_PREFIX, "loaded");
})();
