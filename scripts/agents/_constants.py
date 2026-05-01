"""Tunable configuration values shared by the agent system."""

# RunPod provisioning
# gpuTypeId verified against RunPod's GraphQL gpuTypes catalog (displayName "H100 SXM").
RUNPOD_GPU_TYPE = "NVIDIA H100 80GB HBM3"
RUNPOD_DISK_GB  = 150
