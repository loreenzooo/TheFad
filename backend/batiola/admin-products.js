/**
 * PRODUCT and CATEGORY — admin screens. Owner: Batiola.
 * Admin pages require roleRequired('AD'); management POSTs also pass the approval-PIN guard.
 */
import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { urlFor } from '../../urls.js';
import { groupProducts, readPhotos, toDecimal, toInt } from '../../utils.js';
import { todo } from '../shared/stub.js';
import { roleRequired } from '../shared/auth.js';

/** Category list screen. Used for the plain GET and to re-show the page after a failed POST. */
async function showCategories(req, res, status = 200) {
  let categories = [];
  try {
    categories = await db.callFunction('fn_list_categories');
  } catch (error) {
    flash(req, 'error', error.message);
  }
  return renderPage(req, res, 'admin/categories.html', { categories }, status);
}

/** Runs one category change: success flashes and redirects, failure flashes and re-shows the list. */
async function changeCategory(req, res, success, action) {
  try {
    await action();
  } catch (error) {
    flash(req, 'error', error.message);
    return showCategories(req, res, 400);
  }
  flash(req, 'success', success);
  return res.redirect(urlFor('admin_products.categories'));
}

/** Display order: blank means 0 (first). The database rejects negatives. */
const displayOrder = (value) => (String(value ?? '').trim() === '' ? 0 : toInt(value, 'Display order'));


/** A positive whole number from a query string, or null when missing or invalid. */
function optionalId(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,9}$/.test(text) ? Number.parseInt(text, 10) : null;
}

const notFound = (req, res) => renderPage(req, res, 'error.html', {
  code: 404, heading: 'Page not found', message: 'That product does not exist. Go back to the product list.',
}, 404);

/** Add/edit form. `overrides` holds what the admin typed, so a failed save does not lose it. */
async function showProductForm(req, res, productId, overrides = {}, status = 200) {
  let categories = [];
  let variants = [];
  let item = {};
  try {
    categories = await db.callFunction('fn_list_categories');
    if (productId) {
      item = await db.callFunctionOne('fn_get_product', productId);
      if (!item) return notFound(req, res);
      variants = await db.callFunction('fn_list_variants', productId);
    }
  } catch (error) {
    flash(req, 'error', error.message);
  }
  const product = { ...item, ...overrides };
  return renderPage(req, res, 'admin/product_form.html', {
    editing: Boolean(productId), product, product_id: productId, current: item, categories, variants,
  }, status);
}

/** The page a management button was clicked on, so a deactivate returns there. Same-site admin pages only. */
function backTo(req) {
  try {
    const url = new URL(req.get('referer') || '', 'http://local');
    if (url.pathname.startsWith('/admin/products')) return url.pathname + url.search;
  } catch { /* fall through */ }
  return urlFor('admin_products.index');
}

export default function register(router) {
  // ---------------------------------------------------------------- products
  router.get('/admin/products', 'admin_products.index', roleRequired('AD'), async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const category = optionalId(req.query.category);
    const showInactive = req.query.inactive === '1';
    const variantsView = req.query.variants === '1';
    let categories = [];
    let products = [];
    try {
      categories = await db.callFunction('fn_list_categories');
      products = await db.callFunction('fn_list_products', q || null, category, showInactive);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return renderPage(req, res, 'admin/products.html', {
      products, cards: groupProducts(products), categories, q, category,
      show_inactive: showInactive, variants_view: variantsView,
    });
  });

  router.get('/admin/products/new', 'admin_products.new', roleRequired('AD'),
    (req, res) => showProductForm(req, res, null));

  router.post('/admin/products/new', 'admin_products.new', roleRequired('AD'), async (req, res) => {
    const form = {
      product_name: String(req.body.product_name || '').trim(),
      description: String(req.body.description || '').trim(),
      base_price: String(req.body.base_price || '').trim(),
      category_id: String(req.body.category_id || ''),
      colors: String(req.body.colors || '').trim(),
      sizes: String(req.body.sizes || '').trim(),
    };
    try {
      const { mimes, datas } = readPhotos((req.files || []).filter((file) => file.fieldname === 'photos'));
      const created = await db.callProcedure(
        'sp_create_product', form.product_name, toDecimal(form.base_price, 'Price'),
        toInt(form.category_id, 'Category'), form.description, form.sizes, form.colors, mimes, datas, null,
      );
      flash(req, 'success', 'Product added.');
      return res.redirect(urlFor('admin_products.edit', { product_id: created.p_product_id }));
    } catch (error) {
      flash(req, 'error', error.message);
      return showProductForm(req, res, null, form, 400);
    }
  });

  router.get('/admin/products/:product_id(\\d+)/edit', 'admin_products.edit', roleRequired('AD'),
    (req, res) => showProductForm(req, res, Number(req.params.product_id)));

  router.post('/admin/products/:product_id(\\d+)/edit', 'admin_products.edit', roleRequired('AD'), async (req, res) => {
    const productId = Number(req.params.product_id);
    const form = {
      product_name: String(req.body.product_name || '').trim(),
      description: String(req.body.description || '').trim(),
      base_price: String(req.body.base_price || '').trim(),
      category_id: String(req.body.category_id || ''),
      color: String(req.body.color || '').trim(),
      size: String(req.body.size || '').trim(),
    };
    try {
      await db.callProcedure(
        'sp_update_product', productId, form.product_name, toDecimal(form.base_price, 'Price'),
        toInt(form.category_id, 'Category'), form.size, form.color, form.description, req.body.apply_all === '1',
      );
      flash(req, 'success', 'Product saved.');
      return res.redirect(urlFor('admin_products.index'));
    } catch (error) {
      flash(req, 'error', error.message);
      return showProductForm(req, res, productId, form, 400);
    }
  });

  // DB: fn_get_product, fn_list_product_photos, fn_list_variants
  router.get('/admin/products/:product_id(\\d+)/photos', 'admin_products.photos', roleRequired('AD'), todo({
    owner: 'Batiola',
    feature: 'PRODUCT — photo gallery',
    routines: 'fn_get_product, fn_list_product_photos, fn_list_variants',
    template: 'admin/product_photos.html',
  }));

  // DB: sp_add_product_photo(product_id, mime_type, image_data, apply_all)
  router.post('/admin/products/:product_id(\\d+)/photos/upload', 'admin_products.upload_photos', roleRequired('AD'), todo({
    owner: 'Batiola',
    feature: 'PRODUCT — upload photos',
    routines: 'sp_add_product_photo',
    template: 'admin/product_photos.html',
  }));

  // DB: sp_remove_product_photo(product_id, image_id, apply_all)
  router.post('/admin/products/:product_id(\\d+)/photos/:image_id(\\d+)/remove', 'admin_products.remove_photo', roleRequired('AD'), todo({
    owner: 'Batiola',
    feature: 'PRODUCT — remove photo',
    routines: 'sp_remove_product_photo',
    template: 'admin/product_photos.html',
  }));

  // DB: sp_set_cover_photo(product_id, image_id, apply_all)
  router.post('/admin/products/:product_id(\\d+)/photos/:image_id(\\d+)/cover', 'admin_products.cover_photo', roleRequired('AD'), todo({
    owner: 'Batiola',
    feature: 'PRODUCT — set cover photo',
    routines: 'sp_set_cover_photo',
    template: 'admin/product_photos.html',
  }));

  // DB: sp_add_variant(product_id, size, color)
  router.post('/admin/products/:product_id(\\d+)/add-variant', 'admin_products.add_variant', roleRequired('AD'), async (req, res) => {
    const productId = Number(req.params.product_id);
    try {
      await db.callProcedure(
        'sp_add_variant', productId, String(req.body.size || '').trim(), String(req.body.color || '').trim(), null,
      );
    } catch (error) {
      flash(req, 'error', error.message);
      return showProductForm(req, res, productId, {}, 400);
    }
    flash(req, 'success', 'Color/size added. Its stock starts at 0.');
    return res.redirect(urlFor('admin_products.edit', { product_id: productId }));
  });

  router.post('/admin/products/:product_id(\\d+)/active', 'admin_products.set_active', roleRequired('AD'), async (req, res) => {
    const active = req.body.active === '1';
    try {
      await db.callProcedure('sp_set_product_active', Number(req.params.product_id), active);
      flash(req, 'success', active ? 'Item reactivated. It is back in the shop.' : 'Item deactivated. It no longer shows in the shop.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(backTo(req));
  });

  // -------------------------------------------------------------- categories
  router.get('/admin/products/categories', 'admin_products.categories', roleRequired('AD'),
    (req, res) => showCategories(req, res));

  router.post('/admin/products/categories', 'admin_products.categories', roleRequired('AD'),
    (req, res) => changeCategory(req, res, 'Category added.', () => db.callProcedure(
      'sp_create_category', String(req.body.category_name || '').trim(), displayOrder(req.body.display_order), null,
    )));

  router.post('/admin/products/categories/:category_id(\\d+)', 'admin_products.update_category', roleRequired('AD'),
    (req, res) => changeCategory(req, res, 'Category saved.', () => db.callProcedure(
      'sp_update_category', Number(req.params.category_id), String(req.body.category_name || '').trim(),
      displayOrder(req.body.display_order),
    )));

  router.post('/admin/products/categories/:category_id(\\d+)/delete', 'admin_products.delete_category', roleRequired('AD'),
    (req, res) => changeCategory(req, res, 'Category deleted.', () => db.callProcedure(
      'sp_delete_category', Number(req.params.category_id),
    )));
}