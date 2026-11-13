/**
 * PRODUCT — public shop. Owner: Batiola.
 * Shop list, search suggestions, product page and product photos.
 */
import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { urlFor } from '../../urls.js';
import { compareSizes, groupProducts, stockStatus } from '../../utils.js';

const SORTS = [
  { key: 'featured', label: 'Featured' },
  { key: 'newest', label: 'Newest' },
  { key: 'price_low', label: 'Price: low to high' },
  { key: 'price_high', label: 'Price: high to low' },
  { key: 'name', label: 'Name: A to Z' },
];
const SORT_KEYS = new Set(SORTS.map((entry) => entry.key));

/** A positive whole number from a query string, or null when missing or invalid. */
function optionalId(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,9}$/.test(text) ? Number.parseInt(text, 10) : null;
}

function notFound(req, res) {
  return renderPage(req, res, 'error.html', {
    code: 404, heading: 'Page not found', message: 'That product is not available. Check the address or use the menu.',
  }, 404);
}

function sortCards(cards, sort) {
  const list = [...cards];
  if (sort === 'newest') list.sort((a, b) => b.newest - a.newest);
  else if (sort === 'price_low') list.sort((a, b) => a.price_min - b.price_min || a.name.localeCompare(b.name));
  else if (sort === 'price_high') list.sort((a, b) => b.price_min - a.price_min || a.name.localeCompare(b.name));
  else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
  else return soldOutLast(list);     // 'featured': database order, sold-out items last
  return list;
}

/** Sold-out products go to the end; everything else keeps its order. */
const soldOutLast = (cards) => [
  ...cards.filter((card) => card.status !== 'out'),
  ...cards.filter((card) => card.status === 'out'),
];

/**
 * "All" view: one section per category, in the order the database returned them.
 * Each section previews SECTION_LIMIT products; `total` lets the page link to the full category.
 */
const SECTION_LIMIT = 8;
function sectionsOf(cards) {
  const map = new Map();
  for (const card of cards) {
    if (!map.has(card.category)) map.set(card.category, { name: card.category, category_id: card.rows[0].category_id, all: [] });
    map.get(card.category).all.push(card);
  }
  return [...map.values()].map((section) => {
    const ordered = soldOutLast(section.all);
    return { name: section.name, category_id: section.category_id, total: ordered.length, cards: ordered.slice(0, SECTION_LIMIT) };
  });
}

export default function register(router) {
  // Storefront listing: search, category, in-stock and sort filters.
  router.get('/', 'catalog.index', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const category = optionalId(req.query.category);
    const inStock = req.query.instock === '1';
    const sort = SORT_KEYS.has(req.query.sort) ? req.query.sort : 'featured';
    const filtered = Boolean(q || category || inStock || sort !== 'featured');

    let categories = [];
    let cards = [];
    try {
      categories = await db.callFunction('fn_list_categories');
      const rows = await db.callFunction('fn_list_products', q || null, category, false);
      cards = groupProducts(rows);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    if (inStock) cards = cards.filter((card) => card.stock > 0);
    const sections = filtered ? [] : sectionsOf(cards);   // built from the database order
    cards = sortCards(cards, sort);

    return renderPage(req, res, 'catalog.html', {
      q, category, in_stock: inStock, sort, sorts: SORTS, filtered,
      categories, cards, sections,
    });
  });

  // JSON suggestions for the search box (first 6 matches, one per product).
  router.get('/search-suggestions', 'catalog.suggestions', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json([]);
    try {
      const rows = await db.callFunction('fn_list_products', q, optionalId(req.query.category), false);
      const suggestions = groupProducts(rows).slice(0, 6).map((card) => ({
        name: card.name,
        price: card.price_min,
        url: urlFor('catalog.product', { product_id: card.first_id }),
      }));
      return res.json(suggestions);
    } catch {
      return res.status(503).json({ error: 'Suggestions unavailable.' });
    }
  });

  // Product page: colour picker, sizes, prices, gallery.
  router.get('/product/:product_id(\\d+)', 'catalog.product', async (req, res) => {
    const productId = Number.parseInt(req.params.product_id, 10);
    let item;
    let variants;
    let photos;
    let categories;
    try {
      item = await db.callFunctionOne('fn_get_product', productId);
      if (!item || !item.is_active) return notFound(req, res);
      variants = (await db.callFunction('fn_list_variants', productId)).filter((v) => v.is_active);
      photos = await db.callFunction('fn_list_product_photos', productId);
      categories = await db.callFunction('fn_list_categories');
    } catch (error) {
      flash(req, 'error', error.message);
      return notFound(req, res);
    }

    // One entry per colour (rows without a colour are not offered as a choice).
    const byColor = new Map();
    for (const v of variants) {
      const name = v.color || '';
      if (!byColor.has(name)) byColor.set(name, []);
      byColor.get(name).push(v);
    }
    const colors = [...byColor.entries()]
      .filter(([name]) => name)
      .map(([name, group]) => {
        const stocked = group.filter((v) => v.current_stock > 0);
        return {
          name,
          stock: group.reduce((sum, v) => sum + v.current_stock, 0),
          first_id: (stocked.length ? stocked : group)[0].product_id,
          image_id: group.find((v) => v.image_id)?.image_id ?? null,
        };
      });

    const wanted = String(req.query.color || '');
    const selected = colors.some((c) => c.name === wanted) ? wanted : (item.color || '');
    const shown = (byColor.get(selected) || variants)
      .sort((a, b) => compareSizes(a.size, b.size));

    const stock = shown.reduce((sum, v) => sum + v.current_stock, 0);
    const prices = shown.map((v) => v.current_price);
    const bases = shown.map((v) => v.base_price);

    const photoIds = photos.map((p) => p.image_id);
    const chosen = optionalId(req.query.photo);
    const mainPhoto = photoIds.includes(chosen) ? chosen : (photoIds[0] ?? null);
    const photoUrls = photoIds.map((id) => urlFor('catalog.product_image', { image_id: id }));

    return renderPage(req, res, 'product.html', {
      item,
      category: categories.find((c) => c.category_id === item.category_id)?.category_name || '',
      colors,
      selected,
      variants: shown,
      stock,
      status: stockStatus(stock),
      price_min: prices.length ? Math.min(...prices) : item.base_price,
      price_max: prices.length ? Math.max(...prices) : item.base_price,
      base_price: bases.length ? Math.min(...bases) : item.base_price,
      photo_ids: photoIds,
      photo_urls: photoUrls,
      main_photo: mainPhoto,
      main_index: Math.max(0, photoIds.indexOf(mainPhoto)),
    });
  });

  // Serves a photo stored in the database.
  router.get('/media/product/:image_id(\\d+)', 'catalog.product_image', async (req, res) => {
    let image = null;
    try {
      image = await db.callFunctionOne('fn_get_image', Number.parseInt(req.params.image_id, 10));
    } catch {
      return res.status(503).type('text/plain').send('Image unavailable.');
    }
    if (!image) return res.status(404).type('text/plain').send('Image not found.');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.type(image.mime_type).send(image.image_data);
  });
}