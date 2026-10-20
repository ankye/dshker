package autoconnect

// Wake coalesces exact-pair transport/registration notifications. It does not
// perform network work in the Pion callback or reset another pair's backoff.
func (engine *Engine) Wake(intent Intent) {
	identifier := intent.key()
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.closed {
		return
	}
	engine.wakes[identifier] = intent
	delete(engine.attempts, identifier)
	if cancel := engine.pending[identifier]; cancel != nil {
		close(cancel)
		delete(engine.pending, identifier)
	}
	select {
	case engine.wake <- struct{}{}:
	default:
	}
}

func (engine *Engine) runWakes() {
	defer engine.wait.Done()
	for {
		select {
		case <-engine.ctx.Done():
			return
		case <-engine.wake:
		}
		engine.mu.Lock()
		pending := engine.wakes
		engine.wakes = make(map[string]Intent)
		if engine.closed {
			engine.mu.Unlock()
			return
		}
		for _, intent := range pending {
			engine.wait.Add(1)
			go func(intent Intent) { defer engine.wait.Done(); engine.ensure(intent) }(intent)
		}
		engine.mu.Unlock()
	}
}
