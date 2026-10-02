(function () {
  "use strict";

  const LOG_PREFIX = "[Grouped Tags View]";
  const PLUGIN_ID = "groupedTagsView";

  // Card min width per step of Stash's zoom slider (0-3, Stash default 1).
  const ZOOM_CARD_WIDTHS = [140, 180, 240, 320];

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

  // Search and sidebar filters are evaluated by Stash itself, so the grouped
  // view matches exactly what the original list would find.
  const MATCHING_IDS_QUERY = `
    query GroupedTagsViewMatches($filter: FindFilterType, $tag_filter: TagFilterType) {
      findTags(filter: $filter, tag_filter: $tag_filter) {
        tags { id }
      }
    }
  `;

  // Direct counts, like Stash's own tag cards (no sub-tag content).
  // Only queried when the statistics setting is on.
  const STATS_QUERY = `
    query GroupedTagsViewStats {
      findTags(filter: { per_page: -1 }) {
        tags {
          id
          scene_count
          image_count
          gallery_count
          group_count
          scene_marker_count
          performer_count
          studio_count
        }
      }
    }
  `;

  const SETTINGS_QUERY = `
    query GroupedTagsViewSettings {
      configuration {
        plugins(include: ["${PLUGIN_ID}"])
      }
    }
  `;

  async function gqlRequest(query, variables) {
    const response = await fetch("graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result.errors && result.errors.length) {
      throw new Error(result.errors.map((e) => e.message).join("; "));
    }
    return result.data;
  }

  // Stash unmounts the result area while its own list query loads (e.g. on
  // every search input), so results are cached for as long as the tags page
  // is open. The cache is cleared when the page is left.
  const cache = { tags: null, settings: null, stats: null, matches: new Map() };

  function clearCache() {
    cache.tags = null;
    cache.settings = null;
    cache.stats = null;
    cache.matches.clear();
  }

  function cached(promise, onError) {
    return promise.catch((error) => {
      onError();
      throw error;
    });
  }

  function loadTags() {
    if (!cache.tags) {
      cache.tags = cached(
        gqlRequest(TAGS_QUERY).then((data) => data.findTags.tags),
        () => (cache.tags = null)
      );
    }
    return cache.tags;
  }

  // Unset BOOLEAN settings are missing from the map, which means false.
  function loadSettings() {
    if (!cache.settings) {
      cache.settings = cached(
        gqlRequest(SETTINGS_QUERY).then((data) => {
          const settings = (data.configuration.plugins || {})[PLUGIN_ID] || {};
          return {
            hideUncategorized: settings.hideUncategorized === true,
            hideCounts: settings.hideCounts === true,
            showStatistics: settings.showStatistics === true,
            categoryTag: (settings.categoryTag || "").trim(),
          };
        }),
        () => (cache.settings = null)
      );
    }
    return cache.settings;
  }

  // Map of tag id -> counts.
  function loadStats() {
    if (!cache.stats) {
      cache.stats = cached(
        gqlRequest(STATS_QUERY).then(
          (data) => new Map(data.findTags.tags.map((t) => [t.id, t]))
        ),
        () => (cache.stats = null)
      );
    }
    return cache.stats;
  }

  // Returns a Set of matching tag ids, or null when nothing is filtered.
  function loadMatchingIds(searchTerm, tagFilter) {
    const hasCriteria = tagFilter && Object.keys(tagFilter).length > 0;
    if (!searchTerm && !hasCriteria) {
      return Promise.resolve(null);
    }
    const variables = {
      filter: { q: searchTerm || undefined, per_page: -1 },
      tag_filter: hasCriteria ? tagFilter : undefined,
    };
    const key = JSON.stringify(variables);
    if (!cache.matches.has(key)) {
      cache.matches.set(
        key,
        cached(
          gqlRequest(MATCHING_IDS_QUERY, variables).then(
            (data) => new Set(data.findTags.tags.map((t) => t.id))
          ),
          () => cache.matches.delete(key)
        )
      );
    }
    return cache.matches.get(key);
  }

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

  // Names the category root tag is recognised by when no name is configured.
  const DEFAULT_ROOT_NAMES = ["Kategorien", "Categories"];

  function rootNames(settings) {
    return settings.categoryTag ? [settings.categoryTag] : DEFAULT_ROOT_NAMES;
  }

  function findRoot(byId, names) {
    const wanted = names.map((n) => n.toLowerCase());
    for (const node of byId.values()) {
      if (wanted.includes(node.name.toLowerCase())) return node;
    }
    return null;
  }

  // A tag is a category if it has children, or if it is a direct child of the
  // optional root tag (so a new category shows up before it has children).
  // The root itself is never shown. A tag with several parents appears in
  // each of their groups. Tags without parent and without children are
  // "ungrouped". Categories are sorted by title, "ungrouped" always comes last.
  function buildGroups(byId, root, ungroupedTitle) {
    const groups = [];
    const ungrouped = [];
    for (const node of byId.values()) {
      if (root && node.id === root.id) continue;
      const isCategory =
        node.childIds.length > 0 || (root && node.parentIds.includes(root.id));
      if (isCategory) {
        groups.push({
          key: node.id,
          parent: node,
          sortKey: sortKey(node),
          tags: node.childIds.map((id) => byId.get(id)).sort(compareTags),
        });
      } else if (node.parentIds.length === 0) {
        ungrouped.push(node);
      }
    }
    groups.sort((a, b) => collator.compare(a.sortKey, b.sortKey));
    const categoryCount = groups.length;
    if (ungrouped.length > 0) {
      groups.push({
        key: "ungrouped",
        title: ungroupedTitle,
        tags: ungrouped.sort(compareTags),
      });
    }
    return { groups, categoryCount };
  }

  // Keeps only matching tags and drops groups without matches.
  // If the parent itself matches, its group is shown completely.
  function filterGroups(groups, matchingIds) {
    if (!matchingIds) return groups;
    const result = [];
    for (const group of groups) {
      if (group.parent && matchingIds.has(group.parent.id)) {
        result.push(group);
        continue;
      }
      const tags = group.tags.filter((tag) => matchingIds.has(tag.id));
      if (tags.length > 0) result.push({ ...group, tags });
    }
    return result;
  }

  const { React, ReactDOM } = PluginApi;
  const { Link } = PluginApi.libraries.ReactRouterDOM;
  const { faLayerGroup, faChevronDown, faChevronRight } = PluginApi.libraries.FontAwesomeSolid;
  const { useIntl } = PluginApi.libraries.Intl;
  const { OverlayTrigger, Tooltip } = PluginApi.libraries.Bootstrap;
  const h = React.createElement;

  // --- Texts (follow the language set in Stash) ----------------------------

  const TEXTS = {
    en: {
      grouped: "Grouped",
      loading: "Loading tags …",
      loadError: "Grouped Tags View could not load the tags.",
      noCategories: "No categories yet.",
      noMatches: "No matching tags found.",
      ungrouped: "Ungrouped",
      emptyCategory: "No tags in this category yet.",
      stats: {
        scene: "Scenes",
        image: "Images",
        gallery: "Galleries",
        group: "Groups",
        marker: "Markers",
        performer: "Performers",
        studio: "Studios",
      },
      rootName: "Categories",
      rootHint: (name) =>
        `Tags with the parent tag "${name}" are shown as categories even before they have tags of their own.`,
      createRoot: (name) => `Create tag "${name}"`,
      rootCreated: (name) => `Tag "${name}" created.`,
      dismiss: "Hide",
      collapse: "Collapse",
      expand: "Expand",
    },
    de: {
      grouped: "Gruppiert",
      loading: "Lade Tags …",
      loadError: "Grouped Tags View konnte die Tags nicht laden.",
      noCategories: "Noch keine Kategorien vorhanden.",
      noMatches: "Keine passenden Tags gefunden.",
      ungrouped: "Ohne Gruppe",
      emptyCategory: "Noch keine Tags in dieser Kategorie.",
      stats: {
        scene: "Szenen",
        image: "Bilder",
        gallery: "Galerien",
        group: "Gruppen",
        marker: "Marker",
        performer: "Darsteller",
        studio: "Studios",
      },
      rootName: "Kategorien",
      rootHint: (name) =>
        `Tags mit dem übergeordneten Tag „${name}“ werden als Kategorie angezeigt, auch solange sie noch keine eigenen Tags haben.`,
      createRoot: (name) => `Tag „${name}“ anlegen`,
      rootCreated: (name) => `Tag „${name}“ angelegt.`,
      dismiss: "Ausblenden",
      collapse: "Einklappen",
      expand: "Ausklappen",
    },
  };

  function useTexts() {
    const { locale } = useIntl();
    const language = String(locale || "en").slice(0, 2).toLowerCase();
    return TEXTS[language] || TEXTS.en;
  }

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
  // Same counts, icons and target lists as Stash's own tag card popovers.
  const STAT_TYPES = [
    { key: "scene", field: "scene_count", icon: "faPlayCircle", url: "makeTagScenesUrl" },
    { key: "image", field: "image_count", icon: "faImage", url: "makeTagImagesUrl" },
    { key: "gallery", field: "gallery_count", icon: "faImages", url: "makeTagGalleriesUrl" },
    { key: "group", field: "group_count", icon: "faFilm", url: "makeTagGroupsUrl" },
    { key: "marker", field: "scene_marker_count", icon: "faMapMarkerAlt", url: "makeTagSceneMarkersUrl" },
    { key: "performer", field: "performer_count", icon: "faUser", url: "makeTagPerformersUrl" },
    { key: "studio", field: "studio_count", icon: "faVideo", url: "makeTagStudiosUrl" },
  ];

  function TagStats({ tag, counts, texts }) {
    const { NavUtils } = PluginApi.utils;
    const icons = PluginApi.libraries.FontAwesomeSolid;
    const items = STAT_TYPES.filter((type) => counts[type.field] > 0);
    if (items.length === 0) return null;
    return h(
      "div",
      { className: "gtv-card-stats" },
      items.map((type) =>
        h(
          Link,
          {
            key: type.key,
            to: NavUtils[type.url](tag),
            title: `${texts.stats[type.key]}: ${counts[type.field]}`,
          },
          h(PluginApi.components.Icon, { icon: icons[type.icon] }),
          h("span", null, counts[type.field])
        )
      )
    );
  }

  // The card is not one big link: the statistics are links of their own.
  function TagCard({ tag, counts, texts }) {
    const isDefaultImage = /[?&]default=true/.test(tag.image_path || "");
    return h(
      "div",
      { className: "card gtv-card", title: tag.name },
      h(
        "div",
        { className: isDefaultImage ? "gtv-card-image gtv-default-image" : "gtv-card-image" },
        h(
          Link,
          { to: tagUrl(tag), tabIndex: -1 },
          h("img", { src: tag.image_path, alt: "", loading: "lazy" })
        ),
        counts && h(TagStats, { tag, counts, texts })
      ),
      h(Link, { to: tagUrl(tag), className: "gtv-card-name" }, tag.name)
    );
  }

  // --- Collapsed categories (remembered in the browser) ---------------------

  const COLLAPSED_STORAGE_KEY = "groupedTagsView.collapsed";

  function readCollapsed() {
    try {
      const ids = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || "[]");
      return new Set(Array.isArray(ids) ? ids : []);
    } catch (e) {
      return new Set();
    }
  }

  function useCollapsedGroups() {
    const [collapsed, setCollapsed] = React.useState(readCollapsed);
    const toggle = (key) => {
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]));
        } catch (e) {
          // storage blocked: state only lasts for this page load
        }
        return next;
      });
    };
    return [collapsed, toggle];
  }

  // onToggle is null while searching or filtering: then every category is
  // open and cannot be collapsed, so no match stays hidden.
  function TagGroup({ title, parent, tags, showCount, stats, texts, collapsed, onToggle }) {
    const heading = parent
      ? h(Link, { to: tagUrl(parent) }, parent.name)
      : h("span", null, title);
    // The whole heading row toggles, except the link to the category tag.
    const onHeadingClick = (event) => {
      if (onToggle && !event.target.closest("a")) onToggle();
    };
    const content =
      tags.length > 0
        ? h(
            "div",
            { className: "gtv-grid" },
            tags.map((tag) =>
              h(TagCard, { key: tag.id, tag, counts: stats && stats.get(tag.id), texts })
            )
          )
        : h("p", { className: "gtv-empty-category" }, texts.emptyCategory);
    return h(
      "section",
      { className: collapsed ? "gtv-group gtv-collapsed" : "gtv-group" },
      h(
        "h3",
        {
          className: onToggle ? "gtv-group-title gtv-collapsible" : "gtv-group-title",
          onClick: onHeadingClick,
        },
        onToggle &&
          h(
            "button",
            {
              type: "button",
              className: "gtv-collapse-toggle",
              "aria-expanded": !collapsed,
              title: collapsed ? texts.expand : texts.collapse,
            },
            h(PluginApi.components.Icon, { icon: collapsed ? faChevronRight : faChevronDown })
          ),
        heading,
        showCount && h("span", { className: "gtv-group-count" }, tags.length)
      ),
      !collapsed && content
    );
  }

  const ROOT_HINT_STORAGE_KEY = "groupedTagsView.rootHintDismissed";

  function readRootHintDismissed() {
    try {
      return localStorage.getItem(ROOT_HINT_STORAGE_KEY) === "true";
    } catch (e) {
      return false;
    }
  }

  // The only write the plugin does: creating the root tag, on explicit click.
  function RootTagHint({ name, texts, onCreated }) {
    const [createTag] = PluginApi.utils.StashService.useTagCreate();
    const Toast = PluginApi.hooks.useToast();
    const [dismissed, setDismissed] = React.useState(readRootHintDismissed);
    const [busy, setBusy] = React.useState(false);

    if (dismissed) return null;

    const onCreate = async () => {
      setBusy(true);
      try {
        await createTag({ variables: { input: { name, ignore_auto_tag: true } } });
        Toast.success(texts.rootCreated(name));
        onCreated();
      } catch (error) {
        Toast.error(error);
        setBusy(false);
      }
    };

    const onDismiss = () => {
      try {
        localStorage.setItem(ROOT_HINT_STORAGE_KEY, "true");
      } catch (e) {
        // storage blocked: hint only hidden for this page load
      }
      setDismissed(true);
    };

    return h(
      "div",
      { className: "gtv-root-hint" },
      h("span", null, texts.rootHint(name)),
      h(
        "button",
        { type: "button", className: "btn btn-primary btn-sm", disabled: busy, onClick: onCreate },
        texts.createRoot(name)
      ),
      h(
        "button",
        { type: "button", className: "btn btn-secondary btn-sm", onClick: onDismiss },
        texts.dismiss
      )
    );
  }

  function useAsync(load, deps) {
    const [state, setState] = React.useState({ status: "loading" });
    React.useEffect(() => {
      let cancelled = false;
      load()
        .then((value) => {
          if (!cancelled) setState({ status: "ready", value });
        })
        .catch((error) => {
          console.error(LOG_PREFIX, error);
          if (!cancelled) setState({ status: "error" });
        });
      return () => {
        cancelled = true;
      };
    }, deps);
    return state;
  }

  function GroupedTagsView({ filter }) {
    const texts = useTexts();
    const searchTerm = (filter && filter.searchTerm) || "";
    const tagFilter = filter && filter.makeFilter ? filter.makeFilter() : null;
    const filterKey = JSON.stringify([searchTerm, tagFilter]);
    const [reloadKey, setReloadKey] = React.useState(0);
    const [collapsedGroups, toggleGroup] = useCollapsedGroups();

    const tagsState = useAsync(
      () =>
        Promise.all([loadTags(), loadSettings()])
          .then(([tags, settings]) =>
            Promise.all([tags, settings, settings.showStatistics ? loadStats() : null])
          )
          .then(([tags, settings, stats]) => ({
            byId: buildTagGraph(tags),
            settings,
            stats,
          })),
      [reloadKey]
    );
    const matchState = useAsync(
      () => loadMatchingIds(searchTerm, tagFilter),
      [filterKey, reloadKey]
    );

    const reload = () => {
      clearCache();
      setReloadKey((n) => n + 1);
    };

    let content;
    if (tagsState.status === "error" || matchState.status === "error") {
      content = h("p", { className: "gtv-message" }, texts.loadError);
    } else if (tagsState.status === "loading" || matchState.status === "loading") {
      content = h("p", { className: "gtv-message" }, texts.loading);
    } else {
      const { byId, settings, stats } = tagsState.value;
      const root = findRoot(byId, rootNames(settings));
      const { groups, categoryCount } = buildGroups(byId, root, texts.ungrouped);
      const shownGroups = settings.hideUncategorized
        ? groups.filter((group) => group.parent)
        : groups;
      const visibleGroups = filterGroups(shownGroups, matchState.value);
      content = [
        !root &&
          h(RootTagHint, {
            key: "root-hint",
            name: settings.categoryTag || texts.rootName,
            texts,
            onCreated: reload,
          }),
        categoryCount === 0 &&
          h("p", { key: "empty", className: "gtv-message" }, texts.noCategories),
        matchState.value &&
          visibleGroups.length === 0 &&
          h("p", { key: "no-match", className: "gtv-message" }, texts.noMatches),
        ...visibleGroups.map((group) =>
          h(TagGroup, {
            key: group.key,
            title: group.title,
            parent: group.parent,
            tags: group.tags,
            showCount: !settings.hideCounts,
            stats,
            texts,
            collapsed: !matchState.value && collapsedGroups.has(group.key),
            onToggle: matchState.value ? null : () => toggleGroup(group.key),
          })
        ),
      ];
    }

    const zoomIndex = filter && Number.isInteger(filter.zoomIndex) ? filter.zoomIndex : 1;
    const cardWidth =
      ZOOM_CARD_WIDTHS[Math.min(Math.max(zoomIndex, 0), ZOOM_CARD_WIDTHS.length - 1)];

    return h(
      "div",
      { id: "grouped-tags-view", style: { "--gtv-card-width": `${cardWidth}px` } },
      content
    );
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
    const texts = useTexts();
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

    // Same tooltip as Stash's own display mode buttons.
    return ReactDOM.createPortal(
      h(
        OverlayTrigger,
        { overlay: h(Tooltip, { id: "gtv-display-mode-tooltip" }, texts.grouped) },
        h(
          "button",
          {
            type: "button",
            className: "btn btn-secondary gtv-mode-button" + (active ? " active" : ""),
            "aria-label": texts.grouped,
            onClick,
          },
          h(PluginApi.components.Icon, { icon: faLayerGroup })
        )
      ),
      group
    );
  }

  // FilteredTagList is the whole tags page (/tags) and is always rendered,
  // also while the result is loading, so the button lives here.
  // "after" functions get (props, context, result): result is the last argument.
  PluginApi.patch.after("FilteredTagList", function (...args) {
    const result = args[args.length - 1];
    return h(React.Fragment, null, result, h(GroupedModeButton), h(TagsPageLifecycle));
  });

  function TagsPageLifecycle() {
    React.useEffect(() => clearCache, []);
    return null;
  }

  function DisplayModeSync({ displayMode }) {
    React.useEffect(() => {
      if (viewState.displayMode !== displayMode) viewState.set({ displayMode });
    }, [displayMode]);
    return null;
  }

  function GroupedOrOriginal({ displayMode, filter, renderOriginal }) {
    const state = useViewState();
    const grouped = state.grouped && displayMode === GRID_DISPLAY_MODE;
    return h(
      React.Fragment,
      null,
      h(DisplayModeSync, { displayMode }),
      grouped ? h(GroupedTagsView, { filter }) : renderOriginal()
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
      filter: props.filter,
      renderOriginal: () => next(...originalArgs),
    });
  });

  console.log(LOG_PREFIX, "loaded");
})();
