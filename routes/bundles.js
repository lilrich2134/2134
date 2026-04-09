const express = require('express');
const { db } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const config = require('../config');
    const { provider, minPrice, maxPrice, search, popular } = req.query;
    const globalDiscount = config.system?.globalDiscount || 0;
    
    let query = "SELECT * FROM bundles WHERE status = 'active' AND provider_bundle_code IS NOT NULL AND provider_bundle_code != '' AND provider_bundle_code != id";
    const params = [];

    if (provider) {
      query += ' AND provider = ?';
      params.push(provider);
    }

    if (minPrice) {
      query += ' AND price >= ?';
      params.push(parseFloat(minPrice));
    }

    if (maxPrice) {
      query += ' AND price <= ?';
      params.push(parseFloat(maxPrice));
    }

    if (search) {
      query += ' AND (name LIKE ? OR size_display LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (popular === 'true') {
      query += ' AND popular = 1';
    }

    query += ' ORDER BY provider, price ASC';

    const bundles = db.prepare(query).all(...params).map(bundle => {
      // Create a copy to avoid side effects if better-sqlite3 returns raw objects
      const processedBundle = { ...bundle };
      
      // Migration for old bundles that don't have network/code set properly
      if (!processedBundle.network) processedBundle.network = bundle.provider;
      if (!processedBundle.provider_bundle_code) processedBundle.provider_bundle_code = bundle.id;
      
      // The 'price' field served to users should always be the retail_price from the DB
      // unless a global discount is applied.
      processedBundle.price = bundle.retail_price;

      if (globalDiscount > 0) {
        processedBundle.original_price = processedBundle.price;
        processedBundle.price = parseFloat((processedBundle.price * (1 - globalDiscount / 100)).toFixed(2));
      }

      // Privacy: Hide wholesale_price from non-admins
      if (!req.user || req.user.role !== 'admin') {
        delete processedBundle.wholesale_price;
      }

      return processedBundle;
    });

    res.json({ bundles });
  } catch (error) {
    console.error('Bundles fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bundles' });
  }
});

router.get('/providers', (req, res) => {
  try {
    const config = require('../config');
    const providers = db.prepare('SELECT DISTINCT provider FROM bundles ORDER BY provider').all();
    res.json({ 
      providers: providers.map(p => p.provider),
      whatsapp: {
        number: config.whatsapp.number,
        enabled: config.whatsapp.enabled !== false
      }
    });
  } catch (error) {
    console.error('Providers fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch providers' });
  }
});

router.get('/popular', (req, res) => {
  try {
    const bundles = db.prepare(`
      SELECT * FROM bundles 
      WHERE popular = 1 
      AND status = 'active'
      AND provider_bundle_code IS NOT NULL 
      AND provider_bundle_code != '' 
      AND provider_bundle_code != id
      ORDER BY price ASC
    `).all().map(bundle => {
      const processed = { ...bundle, price: bundle.retail_price };
      if (!req.user || req.user.role !== 'admin') {
        delete processed.wholesale_price;
      }
      return processed;
    });
    res.json({ bundles });
  } catch (error) {
    console.error('Popular bundles fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch popular bundles' });
  }
});

router.get('/recommendations', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;

    const purchasedProviders = db.prepare(`
      SELECT DISTINCT b.provider, COUNT(*) as count
      FROM orders o
      JOIN bundles b ON o.bundle_id = b.id
      WHERE o.user_id = ?
      GROUP BY b.provider
      ORDER BY count DESC
      LIMIT 1
    `).get(userId);

    let recommendations;
    
    if (purchasedProviders) {
      recommendations = db.prepare(`
        SELECT * FROM bundles 
        WHERE provider = ? 
        AND status = 'active' 
        AND provider_bundle_code IS NOT NULL 
        AND provider_bundle_code != '' 
        AND provider_bundle_code != id
        ORDER BY popular DESC, price ASC 
        LIMIT 4
      `).all(purchasedProviders.provider);
    } else {
      recommendations = db.prepare(`
        SELECT * FROM bundles 
        WHERE popular = 1 
        AND status = 'active'
        AND provider_bundle_code IS NOT NULL 
        AND provider_bundle_code != '' 
        AND provider_bundle_code != id
        ORDER BY price ASC 
        LIMIT 4
      `).all();
    }

    recommendations = recommendations.map(bundle => {
      const processed = { ...bundle, price: bundle.retail_price };
      if (!req.user || req.user.role !== 'admin') {
        delete processed.wholesale_price;
      }
      return processed;
    });

    const hour = new Date().getHours();
    let timeBasedSuggestion = 'daily';
    if (hour >= 18 || hour < 6) {
      timeBasedSuggestion = 'night';
    } else if (hour >= 6 && hour < 12) {
      timeBasedSuggestion = 'morning';
    }

    res.json({ 
      recommendations, 
      basedOn: purchasedProviders ? purchasedProviders.provider : 'popular',
      timeOfDay: timeBasedSuggestion
    });
  } catch (error) {
    console.error('Recommendations fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

router.get('/wholesale', authenticateToken, requireRole('agent'), (req, res) => {
  try {
    const { provider } = req.query;
    
    // Privacy: Remove wholesale_price and margin from agent wholesale view
    // Agents should only see retail prices in this context as well
    let query = "SELECT * FROM bundles WHERE status = 'active' AND provider_bundle_code IS NOT NULL AND provider_bundle_code != '' AND provider_bundle_code != id";
    const params = [];

    if (provider) {
      query += ' AND provider = ?';
      params.push(provider);
    }

    query += ' ORDER BY provider, price ASC';

    const bundles = db.prepare(query).all(...params).map(b => {
      const processed = { ...b, price: b.retail_price };
      delete processed.wholesale_price;
      return processed;
    });

    res.json({ bundles });
  } catch (error) {
    console.error('Wholesale bundles fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch wholesale bundles' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const bundle = db.prepare('SELECT * FROM bundles WHERE id = ?').get(req.params.id);
    
    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    // Privacy: Hide wholesale_price from non-admins
    if (!req.user || req.user.role !== 'admin') {
      delete bundle.wholesale_price;
    }

    res.json({ bundle });
  } catch (error) {
    console.error('Bundle fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bundle' });
  }
});

module.exports = router;
