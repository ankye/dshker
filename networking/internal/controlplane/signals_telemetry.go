package controlplane

import (
	"errors"
	"log"
	"time"
)

// v2 health/authorization belongs exclusively to the current WSS registration.
// This independent, joined worker only reports the existing build/lastSeen and
// legacy directory telemetry. HTTPS success never proves WSS health, and HTTPS
// failure never tears down an otherwise healthy v2 control owner.
func (signals *Signals) maintainTelemetry(client *Client, deviceID string) {
	defer close(signals.telemetryDone)
	ticker := time.NewTicker(signalHeartbeatInterval)
	defer ticker.Stop()
	for {
		if err := signals.reportTelemetry(client, deviceID); err != nil && signals.ctx.Err() == nil {
			log.Printf("[p2p] directory telemetry failed: %s", err.Error())
		}
		select {
		case <-signals.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (signals *Signals) reportTelemetry(client *Client, deviceID string) error {
	var result struct {
		DeviceID string `json:"deviceId"`
		At       int64  `json:"at"`
	}
	if err := client.call(signals.ctx, "POST", "/v1/heartbeat", "", client.heartbeat(), &result); err != nil {
		return err
	}
	if result.DeviceID != deviceID {
		return errors.New("p2p.identity_mismatch")
	}
	return nil
}
