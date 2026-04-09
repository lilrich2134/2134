const config = require('../config');

class MockProvider {
  static async processOrder(order, provider) {
    const delay = this.getDelay();
    
    await new Promise(resolve => setTimeout(resolve, delay));

    if (this.shouldFail()) {
      return {
        success: false,
        error: 'Provider temporarily unavailable',
        shouldRetry: true,
        providerRef: null
      };
    }

    return {
      success: true,
      providerRef: 'PRV' + Math.random().toString(36).substring(2, 12).toUpperCase(),
      message: `Order processed successfully via ${provider}`,
      processingTime: delay
    };
  }

  static async processWithFailover(order, primaryProvider) {
    const providerKey = primaryProvider.toLowerCase();
    const isPrimaryDisabled = config.providers[providerKey] && config.providers[providerKey].enabled === false;
    
    let result;
    
    if (isPrimaryDisabled) {
      console.log(`Primary provider ${primaryProvider} is manually disabled. Checking failover...`);
      result = { success: false, shouldRetry: true, error: 'Provider paused' };
    } else {
      result = await this.processOrder(order, primaryProvider);
    }
    
    if (!result.success && result.shouldRetry) {
      if (config.providers.backup && config.providers.backup.enabled) {
        console.log(`Failing over to backup provider...`);
        const backupResult = await this.processOrder(order, 'Backup');
        backupResult.backupUsed = true;
        return backupResult;
      } else {
        console.log('Primary provider unavailable and Backup provider is disabled.');
      }
    } else {
      result.backupUsed = false;
    }

    return result;
  }

  static getDelay() {
    if (config.mock.slowMode) {
      return Math.random() * (config.mock.maxDelay - config.mock.minDelay) + config.mock.minDelay;
    }
    return Math.random() * 500 + 200;
  }

  static shouldFail() {
    return Math.random() < config.mock.failureRate;
  }

  static getOrderStatus(order) {
    const now = Date.now();
    const created = new Date(order.created_at).getTime();
    const elapsed = (now - created) / 1000;

    if (order.status === 'completed' || order.status === 'failed') {
      return order.status;
    }

    if (elapsed < 20) return 'pending';
    if (elapsed < 40) return 'processing';
    if (elapsed < 60) return 'processing'; // Reach 20s processing (20 to 60)
    
    return Math.random() > 0.1 ? 'completed' : 'failed';
  }
}

module.exports = MockProvider;
