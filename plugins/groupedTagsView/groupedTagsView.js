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

  const { React, ReactDOM } = PluginApi;
  const { Link } = PluginApi.libraries.ReactRouterDOM;
  const { faLayerGroup } = PluginApi.libraries.FontAwesomeSolid;
  const h = React.createElement;

  // --- View state shared by the toolbar button and the result area ---------

  const STORAGE_KEY = "groupedTagsView.grouped";

  function readGroupedPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "false";
    } catch (e) {
      return true;
    }
  }

  const viewState = {
    grouped: readGroupedPreference(),
    displayMode: null,
    listeners: new Set(),
    set(changes) {
      Object.assign(this, changes);
      if ("grouped" in changes) {
        try {
          localStorage.setItem(STORAGE_KEY, String(this.grouped));
        } catch (e) {
          // storage blocked: preference only lasts for this page load
        }
      }
      this.listeners.forEach((listener) => listener());
    },
  };

  function useViewState() {
    const [, forceRender] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => {
      viewState.listeners.add(forceRender);
      return () => viewState.listeners.delete(forceRender);
    }, []);
    return viewState;
  }

  function isGroupedActive(state) {
    return state.grouped && state.displayMode === GRID_DISPLAY_MODE;
  }

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

  // --- Toolbar button ------------------------------------------------------

  // Stash's display mode buttons (ListViewButtonGroup) are not patchable.
  // The group is the element right before the zoom slider container.
  function findDisplayModeGroup() {
    const zoom = document.querySelector(
      ".tag-list .filtered-list-toolbar .zoom-slider-container"
    );
    const group = zoom && zoom.previousElementSibling;
    return group && group.classList.contains("btn-group") ? group : null;
  }

  // Rendered into Stash's display mode button group via a portal.
  // Grid stays the original gallery; this button switches to grid + grouped.
  function GroupedModeButton() {
    const state = useViewState();
    const [group, setGroup] = React.useState(null);
    const active = isGroupedActive(state);

    React.useEffect(() => {
      setGroup(findDisplayModeGroup());
    });

    const gridButton = group && group.querySelector(".btn:not(.gtv-mode-button)");

    // Clicking Stash's own grid button means "original gallery".
    React.useEffect(() => {
      if (!gridButton) return undefined;
      const onClick = (event) => {
        if (!event.gtvInternal) viewState.set({ grouped: false });
      };
      gridButton.addEventListener("click", onClick);
      return () => gridButton.removeEventListener("click", onClick);
    }, [gridButton]);

    // React marks the grid button active in grid mode; hand that over to
    // this button while the grouped view is shown.
    React.useEffect(() => {
      if (!gridButton) return;
      const gridMode = state.displayMode === GRID_DISPLAY_MODE;
      gridButton.classList.toggle("active", gridMode && !active);
    });

    if (!group) return null;

    const onClick = () => {
      viewState.set({ grouped: true });
      if (state.displayMode !== GRID_DISPLAY_MODE && gridButton) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true });
        event.gtvInternal = true;
        gridButton.dispatchEvent(event);
      }
    };

    return ReactDOM.createPortal(
      h(
        "button",
        {
          type: "button",
          className: "btn btn-secondary gtv-mode-button" + (active ? " active" : ""),
          title: "Gruppiert",
          onClick,
        },
        h(PluginApi.components.Icon, { icon: faLayerGroup })
      ),
      group
    );
  }

  // FilteredTagList is the whole tags page (/tags) and is always rendered,
  // also while the result is loading, so the button lives here.
  // "after" functions get (props, context, result): result is the last argument.
  PluginApi.patch.after("FilteredTagList", function (...args) {
    const result = args[args.length - 1];
    return h(React.Fragment, null, result, h(GroupedModeButton));
  });

  function DisplayModeSync({ displayMode }) {
    React.useEffect(() => {
      if (viewState.displayMode !== displayMode) viewState.set({ displayMode });
    }, [displayMode]);
    return null;
  }

  function GroupedOrOriginal({ displayMode, renderOriginal }) {
    const state = useViewState();
    const grouped = state.grouped && displayMode === GRID_DISPLAY_MODE;
    return h(
      React.Fragment,
      null,
      h(DisplayModeSync, { displayMode }),
      grouped ? h(GroupedTagsView) : renderOriginal()
    );
  }

  // TagList renders the result area of the tags page below Stash's toolbar
  // and sidebar. In grid mode with "grouped" selected it shows the grouped
  // view, otherwise the original rendering.
  // "instead" functions get (props, context, next): next is the last argument.
  PluginApi.patch.instead("TagList", function (...args) {
    const next = args[args.length - 1];
    const originalArgs = args.slice(0, -1);
    const props = args[0];
    return h(GroupedOrOriginal, {
      displayMode: props.filter ? props.filter.displayMode : null,
      renderOriginal: () => next(...originalArgs),
    });
  });

  console.log(LOG_PREFIX, "loaded");
})();
