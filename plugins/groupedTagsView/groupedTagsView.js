(function () {
  "use strict";

  const LOG_PREFIX = "[Grouped Tags View]";

  // DisplayMode.Grid in Stash (src/models/list-filter/types.ts, numeric enum).
  const GRID_DISPLAY_MODE = 0;

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

  const UNCATEGORIZED_TITLE = "Sonstige";

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function sortKey(tag) {
    return tag.sort_name || tag.name;
  }

  function compareTags(a, b) {
    return collator.compare(sortKey(a), sortKey(b));
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
  // Tags without parent and without children end up in "Sonstige".
  // All groups, "Sonstige" included, are sorted alphabetically by title.
  function buildGroups(byId) {
    const groups = [];
    const uncategorized = [];
    for (const node of byId.values()) {
      if (node.childIds.length > 0) {
        groups.push({
          key: node.id,
          parent: node,
          sortKey: sortKey(node),
          tags: node.childIds.map((id) => byId.get(id)).sort(compareTags),
        });
      } else if (node.parentIds.length === 0) {
        uncategorized.push(node);
      }
    }
    const parentGroupCount = groups.length;
    if (uncategorized.length > 0) {
      groups.push({
        key: "uncategorized",
        title: UNCATEGORIZED_TITLE,
        sortKey: UNCATEGORIZED_TITLE,
        tags: uncategorized.sort(compareTags),
      });
    }
    groups.sort((a, b) => collator.compare(a.sortKey, b.sortKey));
    return { groups, parentGroupCount };
  }

  const { React } = PluginApi;
  const { Link } = PluginApi.libraries.ReactRouterDOM;
  const h = React.createElement;

  function tagUrl(tag) {
    return `/tags/${tag.id}`;
  }

  // image_path always points to an image; for tags without an own image
  // Stash serves its default tag placeholder (URL contains default=true).
  function TagCard({ tag }) {
    const isDefaultImage = /[?&]default=true/.test(tag.image_path || "");
    return h(
      Link,
      { to: tagUrl(tag), className: "card gtv-card", title: tag.name },
      h(
        "div",
        { className: isDefaultImage ? "gtv-card-image gtv-default-image" : "gtv-card-image" },
        h("img", { src: tag.image_path, alt: "", loading: "lazy" })
      ),
      h("div", { className: "gtv-card-name" }, tag.name)
    );
  }

  function TagGroup({ title, parent, tags }) {
    const heading = parent
      ? h(Link, { to: tagUrl(parent) }, parent.name)
      : title;
    return h(
      "section",
      { className: "gtv-group" },
      h(
        "h3",
        { className: "gtv-group-title" },
        heading,
        h("span", { className: "gtv-group-count" }, tags.length)
      ),
      h(
        "div",
        { className: "gtv-grid" },
        tags.map((tag) => h(TagCard, { key: tag.id, tag }))
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
      content = h("p", { className: "gtv-message" }, "Lade Tags …");
    } else if (state.status === "error") {
      content = h(
        "p",
        { className: "gtv-message" },
        "Grouped Tags View konnte die Tags nicht laden."
      );
    } else {
      const { groups, parentGroupCount } = state.data;
      content = [
        parentGroupCount === 0 &&
          h("p", { key: "empty", className: "gtv-message" }, "Keine Tag-Gruppen vorhanden."),
        ...groups.map((group) =>
          h(TagGroup, {
            key: group.key,
            title: group.title,
            parent: group.parent,
            tags: group.tags,
          })
        ),
      ];
    }

    return h("div", { id: "grouped-tags-view" }, content);
  }

  // TagList renders the result area of the tags page (/tags) below Stash's
  // toolbar and sidebar. In grid mode it is replaced by the grouped view;
  // list and tagger mode keep the original rendering.
  // "instead" functions get (props, context, next), so next is the last argument.
  PluginApi.patch.instead("TagList", function (...args) {
    const next = args[args.length - 1];
    const props = args[0];
    if (props.filter && props.filter.displayMode === GRID_DISPLAY_MODE) {
      return h(GroupedTagsView);
    }
    return next(...args.slice(0, -1));
  });

  console.log(LOG_PREFIX, "loaded");
})();
