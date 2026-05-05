"""Tunable configuration values shared by the agent system."""

# RunPod provisioning
# gpuTypeId verified against RunPod's GraphQL gpuTypes catalog (displayName "H100 SXM").
RUNPOD_GPU_TYPE       = "NVIDIA H100 80GB HBM3"
RUNPOD_DISK_GB        = 150
# Host RAM floor. The post-training metrics pass on PlantNet skips tf.data
# caching when the estimated decoded-image footprint exceeds the cache cap
# (~119 GiB for the train split at 224² float32 RGB), so caching never helps
# at full resolution. But the previous floor of 29 GiB also routinely paired
# H100s with low-RAM hosts where TensorFlow's per-batch staging buffers and
# the python-side metric accumulators thrash. 64 GiB gives the host enough
# room for batch staging + numpy aggregations without scheduling onto the
# tightest available node, and is still cheap on RunPod.
RUNPOD_MIN_MEMORY_GB  = 64
RUNPOD_MIN_VCPU_COUNT = 8
